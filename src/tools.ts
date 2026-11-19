import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ProfitLensContext } from './context.js';
import { CHANNELS } from './data/types.js';
import { computeChannelPnl } from './finance/channels.js';
import { daysBetween, trailingRange, type DateRange } from './finance/dates.js';
import { buildWeeklyDigest } from './finance/digest.js';
import { forecastCash13Weeks } from './finance/forecast.js';
import { roundDeep, signedPct, usd } from './finance/format.js';
import { computeInventoryAlerts } from './finance/inventory.js';
import { DETECTORS, findProfitLeaks, type LeakType } from './finance/leaks.js';
import { computeSkuMargins } from './finance/margins.js';

/** Errors whose message is safe and useful to show to the model. */
export class ToolInputError extends Error {}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const periodShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(180)
    .optional()
    .describe('Trailing window in days, ending on the data as-of date. Ignored when from/to are given.'),
  from: isoDate.optional().describe('Start date (inclusive, YYYY-MM-DD). Requires `to`.'),
  to: isoDate.optional().describe('End date (inclusive, YYYY-MM-DD). Requires `from`.'),
};

export function resolveRange(
  ctx: ProfitLensContext,
  input: { days?: number | undefined; from?: string | undefined; to?: string | undefined },
  defaultDays: number,
): DateRange {
  const { startDate, asOf } = ctx.dataset.meta;
  if (input.from !== undefined || input.to !== undefined) {
    if (input.from === undefined || input.to === undefined) throw new ToolInputError('Provide both `from` and `to`, or neither.');
    if (input.from > input.to) throw new ToolInputError('`from` must be on or before `to`.');
    if (input.from < startDate || input.to > asOf) {
      throw new ToolInputError(`Data covers ${startDate} to ${asOf}. Pick dates inside that range.`);
    }
    return { from: input.from, to: input.to };
  }
  const available = daysBetween(startDate, asOf) + 1;
  return trailingRange(asOf, Math.min(input.days ?? defaultDays, available));
}

function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  const payload = roundDeep({ summary, ...data });
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function fail(error: unknown): CallToolResult {
  const message =
    error instanceof ToolInputError ? error.message : `Internal error: ${error instanceof Error ? error.message : String(error)}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wraps a handler so validation and runtime errors come back as tool errors instead of protocol errors. */
function safe<A>(handler: (args: A) => CallToolResult | Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };
}

/** Escapes Slack control characters so user text cannot trigger @channel pings or fake links. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerTools(server: McpServer, ctx: ProfitLensContext): void {
  const { dataset, assumptions } = ctx;

  server.registerTool(
    'get_store_overview',
    {
      title: 'Store overview',
      description:
        'Start here. Returns the store, the date range the data covers, the product catalog and headline numbers for the last 30 days, so you know which SKUs, channels and dates the other tools accept.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(() => {
      const range = trailingRange(dataset.meta.asOf, 30);
      const pnl = computeChannelPnl(dataset, assumptions, range);
      return ok(
        `${dataset.meta.storeName}: data from ${dataset.meta.startDate} to ${dataset.meta.asOf}. Last 30 days: ${usd(pnl.total.netRevenue)} net revenue, ${usd(pnl.total.cm3)} contribution after ads (CM3), ${pnl.total.orders} orders.`,
        {
          store: dataset.meta,
          assumptionsSource: ctx.assumptionsSource,
          channels: CHANNELS,
          catalog: dataset.products,
          last30Days: { range, ...pnl.total },
        },
      );
    }),
  );

  server.registerTool(
    'get_sku_margins',
    {
      title: 'SKU contribution margins',
      description:
        'Contribution margin per SKU: net revenue, COGS, shipping subsidy, 3PL fulfillment, payment fees and allocated ad spend, reported as CM1 (after COGS), CM2 (after fulfillment and fees) and CM3 (after ads), in dollars, % of net revenue and per unit. Use it to see which products actually make money.',
      inputSchema: {
        ...periodShape,
        sku: z.string().optional().describe('Return a single SKU (e.g. "AA-PLNT-CI").'),
        sortBy: z.enum(['cm3', 'cm3Pct', 'netRevenue', 'units', 'refundRatePct']).default('cm3'),
        order: z.enum(['asc', 'desc']).default('asc').describe('asc puts the worst SKUs first.'),
        limit: z.number().int().min(1).max(50).default(12),
      },
      annotations: READ_ONLY,
    },
    safe(({ days, from, to, sku, sortBy, order, limit }) => {
      const range = resolveRange(ctx, { days, from, to }, 30);
      const report = computeSkuMargins(dataset, assumptions, range);
      let skus = report.skus;
      if (sku) {
        skus = skus.filter((s) => s.sku.toLowerCase() === sku.toLowerCase());
        if (skus.length === 0) throw new ToolInputError(`Unknown SKU "${sku}". Call get_store_overview for the catalog.`);
      }
      const direction = order === 'asc' ? 1 : -1;
      skus = [...skus].sort((a, b) => (a[sortBy] - b[sortBy]) * direction).slice(0, limit);
      const losers = report.skus.filter((s) => s.cm3 < 0);
      return ok(
        `${range.from} to ${range.to}: ${usd(report.totals.cm3)} CM3 (${report.totals.cm3Pct.toFixed(1)}% of ${usd(report.totals.netRevenue)} net revenue). ` +
          (losers.length > 0
            ? `${losers.length} SKU(s) lose money after ads: ${losers.map((s) => `${s.name} (${usd(s.cm3)})`).join(', ')}.`
            : 'Every SKU is profitable after ads.'),
        { range, totals: report.totals, unallocatedAdSpend: report.unallocatedAdSpend, skus },
      );
    }),
  );

  server.registerTool(
    'get_channel_pnl',
    {
      title: 'Channel P&L',
      description:
        'Profit and loss per acquisition channel (Meta, Google, TikTok, email, organic) with orders, new customers, net revenue, CM2, ad spend, CM3, AOV, ROAS, breakeven ROAS and CAC, plus store totals (MER, blended CAC) and the change vs the previous period of the same length.',
      inputSchema: {
        ...periodShape,
        channel: z.enum(CHANNELS).optional().describe('Return a single channel.'),
      },
      annotations: READ_ONLY,
    },
    safe(({ days, from, to, channel }) => {
      const range = resolveRange(ctx, { days, from, to }, 30);
      const report = computeChannelPnl(dataset, assumptions, range);
      const channels = channel ? report.channels.filter((c) => c.channel === channel) : report.channels;
      const worst = [...report.channels].sort((a, b) => a.cm3 - b.cm3)[0];
      return ok(
        `${range.from} to ${range.to}: net revenue ${usd(report.total.netRevenue)} (${signedPct(report.change.netRevenuePct)} vs previous period), ` +
          `ad spend ${usd(report.total.adSpend)} (${signedPct(report.change.adSpendPct)}), CM3 ${usd(report.total.cm3)} (${signedPct(report.change.cm3Pct)}), ` +
          `MER ${report.total.mer?.toFixed(2) ?? 'n/a'}x.` +
          (worst && worst.cm3 < 0 ? ` ${worst.channel} is losing ${usd(-worst.cm3)} after ads.` : ''),
        { ...report, channels },
      );
    }),
  );

  server.registerTool(
    'forecast_cash_13_weeks',
    {
      title: '13-week cash forecast',
      description:
        'Direct-method weekly cash forecast (default 13 weeks): cash in from sales, ad spend, variable costs, fixed opex and inventory purchases (open POs plus simulated reorders), with the cash low point, weeks below the minimum cash buffer and projected stockouts. Supports what-if scenarios on ad spend and growth.',
      inputSchema: {
        weeks: z.number().int().min(1).max(26).default(13),
        adSpendChangePct: z
          .number()
          .min(-100)
          .max(300)
          .default(0)
          .describe('Scenario: change paid media budget vs the current run-rate, in percent (e.g. -25).'),
        weeklyGrowthPct: z.number().min(-20).max(20).default(0).describe('Scenario: week-over-week demand growth in percent.'),
        startingCash: z.number().min(0).optional().describe('Override the opening cash balance (USD).'),
      },
      annotations: READ_ONLY,
    },
    safe(({ weeks, adSpendChangePct, weeklyGrowthPct, startingCash }) => {
      const f = forecastCash13Weeks(dataset, assumptions, { weeks, adSpendChangePct, weeklyGrowthPct, startingCash });
      const s = f.summary;
      const buffer =
        s.weeksBelowBuffer.length > 0
          ? `Below the ${usd(s.minCashBuffer)} buffer in week(s) ${s.weeksBelowBuffer.join(', ')}.`
          : `Never below the ${usd(s.minCashBuffer)} buffer.`;
      const stockouts =
        f.projectedStockouts.length > 0
          ? ` Projected stockouts cost ${usd(f.projectedStockouts.reduce((a, x) => a + x.lostRevenue, 0))} of revenue: ${f.projectedStockouts.map((x) => `${x.sku} from ${x.firstStockoutDate}`).join(', ')}.`
          : '';
      return ok(
        `Cash goes from ${usd(s.startingCash)} to ${usd(s.endingCash)} over ${weeks} weeks; low point ${usd(s.lowestClosingCash)} in week ${s.lowestCashWeek}. ${buffer}${stockouts}`,
        { ...f },
      );
    }),
  );

  server.registerTool(
    'get_inventory_reorder_alerts',
    {
      title: 'Inventory reorder alerts',
      description:
        'Per-SKU inventory health: days of cover, projected stockout date, reorder point, inbound POs, and a recommended order quantity rounded to case pack and MOQ. Flags stockout risk (runs out before replenishment can land), reorder-now, and overstock (cash tied up).',
      inputSchema: {
        includeHealthy: z.boolean().default(false).describe('Also return SKUs that need no action.'),
        velocityWindowDays: z.number().int().min(7).max(90).default(28).describe('Days of sales used to measure velocity.'),
      },
      annotations: READ_ONLY,
    },
    safe(({ includeHealthy, velocityWindowDays }) => {
      const report = computeInventoryAlerts(dataset, assumptions, velocityWindowDays);
      const alerts = includeHealthy ? report.alerts : report.alerts.filter((a) => a.status !== 'healthy');
      const names = (status: string): string =>
        report.alerts.filter((a) => a.status === status).map((a) => a.name).join(', ') || 'none';
      return ok(
        `Stockout risk: ${names('stockout_risk')}. Reorder now: ${names('reorder_now')}. Overstock: ${names('overstock')}. ` +
          `Recommended PO value ${usd(report.summary.totalRecommendedOrderValue)}.`,
        { ...report, alerts },
      );
    }),
  );

  const leakTypes = Object.keys(DETECTORS) as [LeakType, ...LeakType[]];
  server.registerTool(
    'find_profit_leaks',
    {
      title: 'Find profit leaks',
      description:
        'Runs every leak detector (unprofitable SKUs, refund-rate outliers, channels whose extra spend returns below breakeven, leaked discount codes, stockout risk, dead stock) and returns the findings ranked by estimated monthly profit impact, each with evidence, a plain-English explanation and a suggested action.',
      inputSchema: {
        ...periodShape,
        types: z.array(z.enum(leakTypes)).min(1).optional().describe('Only run these detectors.'),
        minMonthlyImpact: z.number().min(0).default(0).describe('Hide leaks smaller than this (USD per month).'),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: READ_ONLY,
    },
    safe(({ days, from, to, types, minMonthlyImpact, limit }) => {
      const range = resolveRange(ctx, { days, from, to }, 30);
      const report = findProfitLeaks(dataset, assumptions, range, { minMonthlyImpact, ...(types ? { types } : {}) });
      const top = report.leaks[0];
      return ok(
        report.leaks.length === 0
          ? 'No profit leaks found above the threshold.'
          : `Found ${report.leaks.length} leak(s) worth about ${usd(report.totalMonthlyImpact)}/month. Biggest: ${top?.title ?? ''} (${usd(top?.monthlyImpact ?? 0)}/month).`,
        { ...report, leaks: report.leaks.slice(0, limit) },
      );
    }),
  );

  server.registerTool(
    'post_weekly_digest_to_slack',
    {
      title: 'Post weekly digest to Slack',
      description:
        'Builds the weekly profit digest (KPIs vs last week, top leaks, inventory actions, cash low point) and posts it to Slack. Safe by default: returns a dry-run preview unless the server was started with PROFIT_LENS_ENABLE_SLACK_WRITES=true and a SLACK_WEBHOOK_URL, and even then only posts when called with confirm: true. Show the preview to the user and get their OK before confirming.',
      inputSchema: {
        confirm: z.boolean().default(false).describe('Must be true to actually post. Leave false to preview.'),
        note: z.string().max(500).optional().describe('Optional short note from the user, shown at the top of the digest.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ confirm, note }) => {
      const digest = buildWeeklyDigest(dataset, assumptions, note ? escapeSlack(note) : undefined);
      if (!ctx.slack.writesEnabled) {
        return ok(
          'Dry run: Slack writes are disabled on this server, so nothing was posted. The preview below is what would be sent.',
          {
            mode: 'dry_run',
            reason: ctx.slack.configured
              ? 'SLACK_WEBHOOK_URL is set but PROFIT_LENS_ENABLE_SLACK_WRITES is not true.'
              : 'SLACK_WEBHOOK_URL is not set.',
            preview: digest.text,
            digest,
          },
        );
      }
      if (!confirm) {
        return ok('Preview only. Show it to the user; call again with confirm: true to post it.', {
          mode: 'preview',
          preview: digest.text,
          digest,
        });
      }
      await ctx.slack.post(digest.text);
      return ok('Posted the weekly digest to Slack.', { mode: 'posted', preview: digest.text, digest });
    }),
  );
}
