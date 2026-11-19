/**
 * Golden-scenario evals. Each scenario calls a tool through a real MCP client
 * (in-memory transport, so it exercises zod validation, serialization and
 * rounding exactly as an agent sees them) and checks the answer a finance
 * lead would expect from the demo store.
 *
 * Run: npm run eval
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext } from '../src/context.js';
import { SCENARIO } from '../src/data/generator.js';
import { createServer } from '../src/server.js';

type Json = Record<string, any>;

interface Scenario {
  name: string;
  tool: string;
  args?: Record<string, unknown>;
  expectError?: RegExp;
  /** Returns a list of failed expectations (empty = pass). */
  check?: (data: Json) => string[];
}

const expect = (condition: boolean, message: string): string[] => (condition ? [] : [message]);
const near = (actual: number, golden: number, tolerancePct = 0.01): boolean =>
  Math.abs(actual - golden) <= Math.abs(golden) * (tolerancePct / 100);

const PLANTED = [
  SCENARIO.heavyLowMarginSku,
  SCENARIO.highRefundSku,
  SCENARIO.overstockedSku,
  SCENARIO.overspendingChannel,
  SCENARIO.leakedDiscountCode,
  ...SCENARIO.stockoutRiskSkus,
];
const HEALTHY = ['meta', 'google', 'AA-CNDL-CED', 'AA-SOAP-3P', 'WELCOME10', 'VIP15'];

const scenarios: Scenario[] = [
  {
    name: 'Overview anchors the dataset',
    tool: 'get_store_overview',
    check: (d) => [
      ...expect(d.store.asOf === '2026-11-15', `asOf is ${d.store.asOf}`),
      ...expect(d.catalog.length === 12, `catalog has ${d.catalog.length} SKUs`),
    ],
  },
  {
    name: 'Golden 30-day totals have not drifted',
    tool: 'get_channel_pnl',
    args: { days: 30 },
    check: (d) => [
      ...expect(near(d.total.netRevenue, 358310.7), `net revenue ${d.total.netRevenue} != 358310.70`),
      ...expect(near(d.total.adSpend, 83617.41), `ad spend ${d.total.adSpend} != 83617.41`),
      ...expect(near(d.total.cm3, 105409.31), `CM3 ${d.total.cm3} != 105409.31`),
    ],
  },
  {
    name: 'Heavy planter is the worst SKU after ads',
    tool: 'get_sku_margins',
    args: { days: 30, sortBy: 'cm3', order: 'asc', limit: 3 },
    check: (d) => [
      ...expect(d.skus[0].sku === SCENARIO.heavyLowMarginSku, `worst SKU is ${d.skus[0].sku}`),
      ...expect(d.skus[0].cm3 < 0, 'worst SKU should have negative CM3'),
      ...expect(d.skus[0].perUnit.shippingNet > 10, 'planter should carry a large shipping subsidy'),
    ],
  },
  {
    name: 'Duvet has the highest refund rate',
    tool: 'get_sku_margins',
    args: { days: 90, sortBy: 'refundRatePct', order: 'desc', limit: 1 },
    check: (d) => expect(d.skus[0].sku === SCENARIO.highRefundSku, `highest refund SKU is ${d.skus[0].sku}`),
  },
  {
    name: 'TikTok is the only channel losing money (28d)',
    tool: 'get_channel_pnl',
    args: { days: 28 },
    check: (d) => {
      const losing = d.channels.filter((c: Json) => c.cm3 < 0).map((c: Json) => c.channel);
      return [
        ...expect(losing.length === 1 && losing[0] === 'tiktok', `losing channels: ${losing.join(', ')}`),
        ...expect(d.total.mer > 3 && d.total.mer < 6, `MER ${d.total.mer} outside 3-6x`),
      ];
    },
  },
  {
    name: 'Leak detection finds every planted problem and nothing healthy',
    tool: 'find_profit_leaks',
    args: { days: 30, limit: 25 },
    check: (d) => {
      const subjects = new Set(d.leaks.map((l: Json) => l.subject));
      return [
        ...PLANTED.filter((s) => !subjects.has(s)).map((s) => `missed ${s}`),
        ...HEALTHY.filter((s) => subjects.has(s)).map((s) => `false positive on ${s}`),
        ...expect(d.leaks[0].id === 'channel_overspend:tiktok', `top leak is ${d.leaks[0].id}`),
      ];
    },
  },
  {
    name: 'Detector filter isolates the leaked discount code',
    tool: 'find_profit_leaks',
    args: { types: ['discount_code_leak'] },
    check: (d) => [
      ...expect(d.leaks.length === 1 && d.leaks[0].subject === 'FRIENDS40', `got ${d.leaks.map((l: Json) => l.subject).join(', ')}`),
      ...expect(d.leaks[0]?.evidence.avgDiscountPct >= 39, 'avg discount should be ~40%'),
    ],
  },
  {
    name: 'Inventory alerts classify stockout, reorder and overstock',
    tool: 'get_inventory_reorder_alerts',
    check: (d) => {
      const by = (status: string): string[] => d.alerts.filter((a: Json) => a.status === status).map((a: Json) => a.sku).sort();
      return [
        ...expect(JSON.stringify(by('stockout_risk')) === JSON.stringify([...SCENARIO.stockoutRiskSkus].sort()), `stockout_risk: ${by('stockout_risk').join(', ')}`),
        ...expect(JSON.stringify(by('overstock')) === JSON.stringify([SCENARIO.overstockedSku]), `overstock: ${by('overstock').join(', ')}`),
        ...expect(by('reorder_now').length === 2, `reorder_now: ${by('reorder_now').join(', ')}`),
      ];
    },
  },
  {
    name: 'Cash forecast reconciles week by week and sees the gift-set stockout',
    tool: 'forecast_cash_13_weeks',
    check: (d) => {
      const broken = d.weeks.filter((w: Json) => Math.abs(w.openingCash + w.netCashFlow - w.closingCash) > 0.02);
      return [
        ...expect(d.weeks.length === 13, `${d.weeks.length} weeks`),
        ...expect(broken.length === 0, `weeks that do not reconcile: ${broken.map((w: Json) => w.week).join(', ')}`),
        ...expect(d.projectedStockouts.some((s: Json) => s.sku === 'AA-GFT-SET'), 'gift set stockout not projected'),
      ];
    },
  },
  {
    name: 'Ad spend scenario cuts spend by exactly the requested share',
    tool: 'forecast_cash_13_weeks',
    args: { adSpendChangePct: -20 },
    check: (d) => [
      ...expect(near(d.summary.totalAdSpend, d.baseline.dailyAdSpend * 91 * 0.8, 0.05), `total ad spend ${d.summary.totalAdSpend}`),
      ...expect(d.baseline.revenueMultiplier < 1, 'revenue should respond to the budget cut'),
    ],
  },
  {
    name: 'Slack digest is a dry run by default',
    tool: 'post_weekly_digest_to_slack',
    args: { confirm: true },
    check: (d) => [
      ...expect(d.mode === 'dry_run', `mode is ${d.mode}`),
      ...expect(/Weekly profit digest/.test(d.preview) && /TikTok/.test(d.preview), 'preview misses the headline or the top leak'),
    ],
  },
  { name: 'Rejects an out-of-range window', tool: 'get_sku_margins', args: { days: 999 }, expectError: /days/ },
  {
    name: 'Explains dates outside the data',
    tool: 'get_channel_pnl',
    args: { from: '2025-01-01', to: '2025-01-31' },
    expectError: /Data covers 2026-05-20 to 2026-11-15/,
  },
];

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(buildTestContext()).connect(serverTransport);
  const client = new Client({ name: 'profit-lens-evals', version: '1.0.0' });
  await client.connect(clientTransport);

  let failed = 0;
  for (const s of scenarios) {
    const result = (await client.callTool({ name: s.tool, arguments: s.args ?? {} })) as CallToolResult;
    const first = result.content[0];
    const text = first?.type === 'text' ? first.text : '';
    let problems: string[];
    if (s.expectError) {
      problems = [
        ...expect(result.isError === true, 'expected a tool error'),
        ...expect(s.expectError.test(text), `error text was: ${text.slice(0, 160)}`),
      ];
    } else if (result.isError) {
      problems = [`tool error: ${text}`];
    } else {
      try {
        problems = s.check?.(result.structuredContent as Json) ?? [];
      } catch (error) {
        problems = [`check threw: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    if (problems.length > 0) failed += 1;
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${s.name}`);
    for (const p of problems) console.log(`      - ${p}`);
  }

  await client.close();
  console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
