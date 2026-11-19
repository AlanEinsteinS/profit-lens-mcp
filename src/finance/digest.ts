import type { Dataset } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { computeChannelPnl } from './channels.js';
import { trailingRange, type DateRange } from './dates.js';
import { forecastCash13Weeks } from './forecast.js';
import { signedPct, usd } from './format.js';
import { computeInventoryAlerts } from './inventory.js';
import { findProfitLeaks } from './leaks.js';

export interface WeeklyDigest {
  storeName: string;
  range: DateRange;
  kpis: {
    netRevenue: number;
    netRevenueChangePct: number;
    cm3: number;
    cm3ChangePct: number;
    adSpend: number;
    mer: number | null;
    orders: number;
  };
  topLeaks: { title: string; monthlyImpact: number; severity: string }[];
  inventoryActions: { sku: string; name: string; status: string; recommendedOrderQty: number }[];
  cash: { lowestClosingCash: number; lowestCashWeek: number; endingCash: number; weeksBelowBuffer: number[] };
  /** Slack mrkdwn rendering of the digest. */
  text: string;
}

/** Builds the Monday-morning summary a finance lead would post to the team channel. */
export function buildWeeklyDigest(dataset: Dataset, assumptions: Assumptions, note?: string): WeeklyDigest {
  const range = trailingRange(dataset.meta.asOf, 7);
  const pnl = computeChannelPnl(dataset, assumptions, range);
  const leaks = findProfitLeaks(dataset, assumptions, trailingRange(dataset.meta.asOf, 30));
  const inventory = computeInventoryAlerts(dataset, assumptions);
  const forecast = forecastCash13Weeks(dataset, assumptions);

  const topLeaks = leaks.leaks.slice(0, 3).map((l) => ({
    title: l.title,
    monthlyImpact: l.monthlyImpact,
    severity: l.severity,
  }));
  const inventoryActions = inventory.alerts
    .filter((a) => a.status === 'stockout_risk' || a.status === 'reorder_now')
    .map((a) => ({ sku: a.sku, name: a.name, status: a.status, recommendedOrderQty: a.recommendedOrderQty }));

  const kpis = {
    netRevenue: pnl.total.netRevenue,
    netRevenueChangePct: pnl.change.netRevenuePct,
    cm3: pnl.total.cm3,
    cm3ChangePct: pnl.change.cm3Pct,
    adSpend: pnl.total.adSpend,
    mer: pnl.total.mer,
    orders: pnl.total.orders,
  };
  const cash = {
    lowestClosingCash: forecast.summary.lowestClosingCash,
    lowestCashWeek: forecast.summary.lowestCashWeek,
    endingCash: forecast.summary.endingCash,
    weeksBelowBuffer: forecast.summary.weeksBelowBuffer,
  };

  const lines = [
    `*Weekly profit digest: ${dataset.meta.storeName}*`,
    `_${range.from} to ${range.to}, vs the previous 7 days_`,
    ...(note ? ['', `> ${note}`] : []),
    '',
    `*Net revenue* ${usd(kpis.netRevenue)} (${signedPct(kpis.netRevenueChangePct)})  |  *CM3* ${usd(kpis.cm3)} (${signedPct(kpis.cm3ChangePct)})`,
    `*Ad spend* ${usd(kpis.adSpend)}  |  *MER* ${kpis.mer === null ? 'n/a' : `${kpis.mer.toFixed(2)}x`}  |  *Orders* ${kpis.orders}`,
    '',
    '*Top profit leaks (monthly impact)*',
    ...topLeaks.map((l, i) => `${i + 1}. ${l.title}: ${usd(l.monthlyImpact)}/mo (${l.severity})`),
    '',
    '*Inventory actions*',
    ...(inventoryActions.length > 0
      ? inventoryActions.map(
          (a) => `- ${a.name} (${a.sku}): ${a.status === 'stockout_risk' ? 'stockout risk' : 'reorder now'}, order about ${a.recommendedOrderQty} units`,
        )
      : ['- Nothing urgent.']),
    '',
    `*Cash (13 weeks)* low point ${usd(cash.lowestClosingCash)} in week ${cash.lowestCashWeek}, ending ${usd(cash.endingCash)}` +
      (cash.weeksBelowBuffer.length > 0
        ? `. Below the ${usd(assumptions.minCashBuffer)} buffer in weeks ${cash.weeksBelowBuffer.join(', ')}.`
        : `, never below the ${usd(assumptions.minCashBuffer)} buffer.`),
  ];

  return {
    storeName: dataset.meta.storeName,
    range,
    kpis,
    topLeaks,
    inventoryActions,
    cash,
    text: lines.join('\n'),
  };
}
