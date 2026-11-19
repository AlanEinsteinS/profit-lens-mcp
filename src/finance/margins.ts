import type { Channel, Dataset } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import type { DateRange } from './dates.js';
import {
  addInto,
  adSpendByChannel,
  contribution,
  emptyTotals,
  lineEconomicsInRange,
  pct,
  type LineEconomics,
  type MoneyTotals,
} from './economics.js';

export interface SkuMargin extends MoneyTotals {
  sku: string;
  name: string;
  category: string;
  cm1: number;
  cm2: number;
  /** Paid media allocated to the SKU (see `allocateAdSpend`). */
  adSpend: number;
  cm3: number;
  cm1Pct: number;
  cm2Pct: number;
  cm3Pct: number;
  refundRatePct: number;
  perUnit: { netRevenue: number; cogs: number; shippingNet: number; cm2: number; adSpend: number; cm3: number };
}

export interface SkuMarginReport {
  range: DateRange;
  skus: SkuMargin[];
  totals: { netRevenue: number; cm2: number; adSpend: number; cm3: number; cm3Pct: number };
  /** Spend on channels that had no attributed revenue in the range. */
  unallocatedAdSpend: number;
}

/**
 * Allocates each paid channel's spend to SKUs in proportion to the net revenue
 * that channel drove for each SKU (last-touch attribution). A SKU that only
 * sells through email or organic therefore carries no paid media cost.
 */
export function allocateAdSpend(
  rows: readonly LineEconomics[],
  spendByChannel: ReadonlyMap<Channel, number>,
): { bySku: Map<string, number>; unallocated: number } {
  const revenueByChannelSku = new Map<Channel, Map<string, number>>();
  const revenueByChannel = new Map<Channel, number>();
  for (const row of rows) {
    const perSku = revenueByChannelSku.get(row.channel) ?? new Map<string, number>();
    perSku.set(row.sku, (perSku.get(row.sku) ?? 0) + row.netRevenue);
    revenueByChannelSku.set(row.channel, perSku);
    revenueByChannel.set(row.channel, (revenueByChannel.get(row.channel) ?? 0) + row.netRevenue);
  }

  const bySku = new Map<string, number>();
  let unallocated = 0;
  for (const [channel, spend] of spendByChannel) {
    const channelRevenue = revenueByChannel.get(channel) ?? 0;
    const perSku = revenueByChannelSku.get(channel);
    if (!perSku || channelRevenue <= 0) {
      unallocated += spend;
      continue;
    }
    for (const [sku, revenue] of perSku) {
      bySku.set(sku, (bySku.get(sku) ?? 0) + (spend * revenue) / channelRevenue);
    }
  }
  return { bySku, unallocated };
}

export function computeSkuMargins(dataset: Dataset, assumptions: Assumptions, range: DateRange): SkuMarginReport {
  const rows = lineEconomicsInRange(dataset, assumptions, range);
  const { bySku: adBySku, unallocated } = allocateAdSpend(rows, adSpendByChannel(dataset, range));

  const totalsBySku = new Map<string, MoneyTotals>();
  for (const row of rows) {
    const totals = totalsBySku.get(row.sku) ?? emptyTotals();
    addInto(totals, row);
    totalsBySku.set(row.sku, totals);
  }

  const skus: SkuMargin[] = dataset.products.map((product) => {
    const t = totalsBySku.get(product.sku) ?? emptyTotals();
    const { cm1, cm2 } = contribution(t);
    const adSpend = adBySku.get(product.sku) ?? 0;
    const cm3 = cm2 - adSpend;
    const perUnit = (value: number): number => (t.units > 0 ? value / t.units : 0);
    return {
      sku: product.sku,
      name: product.name,
      category: product.category,
      ...t,
      cm1,
      cm2,
      adSpend,
      cm3,
      cm1Pct: pct(cm1, t.netRevenue),
      cm2Pct: pct(cm2, t.netRevenue),
      cm3Pct: pct(cm3, t.netRevenue),
      refundRatePct: pct(t.refundedUnits, t.units),
      perUnit: {
        netRevenue: perUnit(t.netRevenue),
        cogs: perUnit(t.cogs),
        shippingNet: perUnit(t.shippingNet),
        cm2: perUnit(cm2),
        adSpend: perUnit(adSpend),
        cm3: perUnit(cm3),
      },
    };
  });

  const netRevenue = skus.reduce((a, s) => a + s.netRevenue, 0);
  const cm2 = skus.reduce((a, s) => a + s.cm2, 0);
  const adSpend = skus.reduce((a, s) => a + s.adSpend, 0);
  const cm3 = cm2 - adSpend;
  return {
    range,
    skus,
    totals: { netRevenue, cm2, adSpend, cm3, cm3Pct: pct(cm3, netRevenue) },
    unallocatedAdSpend: unallocated,
  };
}
