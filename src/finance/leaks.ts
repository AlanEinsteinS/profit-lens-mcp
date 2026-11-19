import { PAID_CHANNELS, type Channel, type Dataset } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { computeChannelPnl } from './channels.js';
import { addDays, previousRange, rangeLength, trailingRange, type DateRange } from './dates.js';
import { contribution, lineEconomicsInRange, pct, productMap } from './economics.js';
import { usd } from './format.js';
import { computeInventoryAlerts } from './inventory.js';
import { computeSkuMargins } from './margins.js';

export type LeakType =
  | 'unprofitable_sku'
  | 'refund_rate_outlier'
  | 'channel_overspend'
  | 'discount_code_leak'
  | 'stockout_risk'
  | 'dead_stock';

export type Severity = 'high' | 'medium' | 'low';

export interface ProfitLeak {
  id: string;
  type: LeakType;
  /** The SKU, channel or discount code the leak is about. */
  subject: string;
  title: string;
  severity: Severity;
  /** Estimated profit lost per 30 days if nothing changes (USD). */
  monthlyImpact: number;
  explanation: string;
  suggestedAction: string;
  evidence: Record<string, number | string | null>;
}

export interface LeakReport {
  asOf: string;
  range: DateRange;
  leaks: ProfitLeak[];
  totalMonthlyImpact: number;
  detectorsRun: LeakType[];
}

export const SEVERITY_THRESHOLDS = { high: 5000, medium: 1500 } as const;

export function severityFor(monthlyImpact: number): Severity {
  if (monthlyImpact >= SEVERITY_THRESHOLDS.high) return 'high';
  if (monthlyImpact >= SEVERITY_THRESHOLDS.medium) return 'medium';
  return 'low';
}

function leak(fields: Omit<ProfitLeak, 'id' | 'severity'>): ProfitLeak {
  return { id: `${fields.type}:${fields.subject}`, severity: severityFor(fields.monthlyImpact), ...fields };
}

type Detector = (dataset: Dataset, assumptions: Assumptions, range: DateRange) => ProfitLeak[];

/** SKUs that lose money after their share of paid media. */
export const detectUnprofitableSkus: Detector = (dataset, assumptions, range) => {
  const report = computeSkuMargins(dataset, assumptions, range);
  const monthly = 30 / rangeLength(range);
  return report.skus
    .filter((s) => s.cm3 < 0 && s.netRevenue >= report.totals.netRevenue * 0.01)
    .map((s) => {
      const u = s.perUnit;
      const shippingShare = pct(u.shippingNet, u.netRevenue);
      return leak({
        type: 'unprofitable_sku',
        subject: s.sku,
        title: `${s.name} loses ${usd(-u.cm3)} per unit after ads`,
        monthlyImpact: -s.cm3 * monthly,
        explanation:
          `Per unit: ${usd(u.netRevenue)} net revenue - ${usd(u.cogs)} COGS - ${usd(u.shippingNet)} shipping subsidy ` +
          `- fees and fulfillment = ${usd(u.cm2)} CM2, then ${usd(u.adSpend)} of allocated ads = ${usd(u.cm3)} CM3. ` +
          (shippingShare > 15
            ? `Shipping alone eats ${Math.round(shippingShare)}% of the selling price: the product is heavy and ships free above the threshold.`
            : `Margin before ads is too thin to carry its share of paid media.`),
        suggestedAction:
          shippingShare > 15
            ? 'Add a shipping surcharge or raise the price for this SKU, exclude it from free-shipping and from paid prospecting, or renegotiate the oversize carrier rate.'
            : 'Raise the price, renegotiate COGS, or exclude the SKU from paid campaigns.',
        evidence: {
          units: s.units,
          netRevenue: s.netRevenue,
          cm2Pct: s.cm2Pct,
          cm3: s.cm3,
          shippingSubsidyPerUnit: u.shippingNet,
          adSpendPerUnit: u.adSpend,
        },
      });
    });
};

/**
 * SKUs whose refund rate is far above the store average. Uses a matured
 * window (orders at least 30 days old) because refunds lag the order date.
 */
export const detectRefundOutliers: Detector = (dataset, assumptions) => {
  const asOf = dataset.meta.asOf;
  const matured: DateRange = { from: addDays(asOf, -119), to: addDays(asOf, -30) };
  const rows = lineEconomicsInRange(dataset, assumptions, matured);
  const products = productMap(dataset);
  const bySku = new Map<string, { units: number; refunded: number; netPrice: number }>();
  let units = 0;
  let refunded = 0;
  for (const row of rows) {
    const s = bySku.get(row.sku) ?? { units: 0, refunded: 0, netPrice: 0 };
    s.units += row.units;
    s.refunded += row.refundedUnits;
    s.netPrice += row.grossRevenue - row.discounts;
    bySku.set(row.sku, s);
    units += row.units;
    refunded += row.refundedUnits;
  }
  const storeRate = units > 0 ? refunded / units : 0;
  const monthly = 30 / rangeLength(matured);

  const leaks: ProfitLeak[] = [];
  for (const [sku, s] of bySku) {
    const rate = s.units > 0 ? s.refunded / s.units : 0;
    if (s.units < 50 || rate < 0.08 || rate < storeRate * 2) continue;
    const product = products.get(sku);
    const netPricePerUnit = s.netPrice / s.units;
    // Profit lost per refunded unit vs a kept sale: the revenue, minus the COGS recovered by restocking.
    const lossPerRefund = netPricePerUnit - (product?.unitCost ?? 0) * assumptions.refundRestockRate;
    const excessRefunds = (rate - storeRate) * s.units;
    leaks.push(
      leak({
        type: 'refund_rate_outlier',
        subject: sku,
        title: `${product?.name ?? sku} refund rate is ${(rate * 100).toFixed(1)}% vs ${(storeRate * 100).toFixed(1)}% store average`,
        monthlyImpact: excessRefunds * lossPerRefund * monthly,
        explanation:
          `${s.refunded} of ${s.units} units sold between ${matured.from} and ${matured.to} were refunded. ` +
          `About ${Math.round(excessRefunds)} refunds above the store-average rate, each costing about ${usd(lossPerRefund)} ` +
          `(net price minus the COGS recovered by restocking).`,
        suggestedAction:
          'Read the refund reasons for this SKU (sizing, quality, damage in transit), fix the product page or packaging, and check the supplier batch.',
        evidence: {
          refundRatePct: rate * 100,
          storeRefundRatePct: storeRate * 100,
          unitsSold: s.units,
          unitsRefunded: s.refunded,
          windowFrom: matured.from,
          windowTo: matured.to,
        },
      }),
    );
  }
  return leaks;
};

/**
 * Paid channels whose budget grew while the extra spend returned less than
 * breakeven. Compares the last 28 days with the 28 days before.
 */
export const detectChannelOverspend: Detector = (dataset, assumptions) => {
  const current = trailingRange(dataset.meta.asOf, 28);
  const now = computeChannelPnl(dataset, assumptions, current);
  const before = computeChannelPnl(dataset, assumptions, previousRange(current));
  const monthly = 30 / 28;

  const leaks: ProfitLeak[] = [];
  for (const channel of PAID_CHANNELS) {
    const a = before.channels.find((c) => c.channel === channel);
    const b = now.channels.find((c) => c.channel === channel);
    if (!a || !b) continue;
    const deltaSpend = b.adSpend - a.adSpend;
    if (deltaSpend < 1000 || deltaSpend < a.adSpend * 0.2) continue;
    const deltaRevenue = b.grossRevenue - b.discounts - (a.grossRevenue - a.discounts);
    const deltaCm2 = b.cm2 - a.cm2;
    const marginalRoas = deltaRevenue / deltaSpend;
    const breakeven = b.breakevenRoas ?? Infinity;
    if (marginalRoas >= breakeven) continue;
    const wasted = deltaSpend - deltaCm2;
    leaks.push(
      leak({
        type: 'channel_overspend',
        subject: channel,
        title: `${channelName(channel)} spend up ${Math.round(pct(deltaSpend, a.adSpend))}% but the extra budget returns ${marginalRoas.toFixed(2)}x (breakeven ${breakeven.toFixed(2)}x)`,
        monthlyImpact: Math.max(0, wasted) * monthly,
        explanation:
          `Spend went from ${usd(a.adSpend)} to ${usd(b.adSpend)} (28 days vs the prior 28) while attributed revenue only moved ` +
          `${usd(deltaRevenue)}. Every extra dollar returned ${marginalRoas.toFixed(2)} in revenue; at this channel's margins it needs ` +
          `${breakeven.toFixed(2)} just to break even. Average ROAS (${(b.roas ?? 0).toFixed(2)}x) hides this because it blends the profitable base budget with the new spend.`,
        suggestedAction: `Roll ${channelName(channel)} back toward the prior budget (about ${usd(a.adSpend / 28)}/day) and scale again only with creative or audience tests that show marginal ROAS above breakeven.`,
        evidence: {
          spendBefore: a.adSpend,
          spendNow: b.adSpend,
          revenueBefore: a.grossRevenue - a.discounts,
          revenueNow: b.grossRevenue - b.discounts,
          marginalRoas,
          breakevenRoas: b.breakevenRoas,
          cacBefore: a.cac,
          cacNow: b.cac,
        },
      }),
    );
  }
  return leaks;
};

/** Deep discount codes whose usage is surging and whose orders barely make money. */
export const detectDiscountCodeLeaks: Detector = (dataset, assumptions, range) => {
  const rows = lineEconomicsInRange(dataset, assumptions, range);
  const prevRows = lineEconomicsInRange(dataset, assumptions, previousRange(range));
  const monthly = 30 / rangeLength(range);

  interface CodeStats { orders: Set<string>; revenue: number; discounts: number; gross: number; cm2: number }
  const collect = (list: typeof rows) => {
    const byCode = new Map<string, CodeStats>();
    const all = { revenue: 0, cm2: 0, orders: new Set<string>() };
    for (const row of list) {
      all.revenue += row.netRevenue;
      all.cm2 += contribution(row).cm2;
      all.orders.add(row.orderId);
      if (!row.discountCode) continue;
      const s = byCode.get(row.discountCode) ?? { orders: new Set<string>(), revenue: 0, discounts: 0, gross: 0, cm2: 0 };
      s.orders.add(row.orderId);
      s.revenue += row.netRevenue;
      s.discounts += row.discounts;
      s.gross += row.grossRevenue;
      s.cm2 += contribution(row).cm2;
      byCode.set(row.discountCode, s);
    }
    return { byCode, all };
  };

  const now = collect(rows);
  const before = collect(prevRows);
  const storeCm2Pct = pct(now.all.cm2, now.all.revenue);
  const leaks: ProfitLeak[] = [];

  for (const [code, s] of now.byCode) {
    const discountPct = pct(s.discounts, s.gross);
    const usageShare = pct(s.orders.size, now.all.orders.size);
    const prevOrders = before.byCode.get(code)?.orders.size ?? 0;
    const growth = prevOrders > 0 ? s.orders.size / prevOrders : Infinity;
    const cm2Pct = pct(s.cm2, s.revenue);
    // Deep (>= 25% off), material (>= 2% of orders), surging (>= 2x) and clearly dilutive (>= 15 pts below store CM2).
    if (discountPct < 25 || usageShare < 2 || growth < 2 || cm2Pct > storeCm2Pct - 15) continue;
    // Count only the discount above a normal 10% welcome offer as leakage.
    const excessDiscount = s.discounts - s.gross * 0.1;
    leaks.push(
      leak({
        type: 'discount_code_leak',
        subject: code,
        title: `Code ${code} (${Math.round(discountPct)}% off) is on ${usageShare.toFixed(1)}% of orders, up ${Number.isFinite(growth) ? `${growth.toFixed(1)}x` : 'from zero'}`,
        monthlyImpact: excessDiscount * monthly,
        explanation:
          `${s.orders.size} orders used ${code} in ${range.from}..${range.to} vs ${prevOrders} in the previous period. ` +
          `Those orders run at a ${cm2Pct.toFixed(1)}% contribution margin before ads, vs ${storeCm2Pct.toFixed(1)}% for the store. ` +
          'A sudden spike in a deep code usually means it leaked to a coupon or deal site.',
        suggestedAction: `Expire or cap ${code} (single use, first order only), replace it with unique codes for partners, and check coupon sites and affiliate traffic.`,
        evidence: {
          orders: s.orders.size,
          previousPeriodOrders: prevOrders,
          usageSharePct: usageShare,
          avgDiscountPct: discountPct,
          discountDollars: s.discounts,
          ordersCm2Pct: cm2Pct,
          storeCm2Pct,
        },
      }),
    );
  }
  return leaks;
};

/** SKUs that will run out before replenishment lands: lost contribution, not just lost revenue. */
export const detectStockoutRisk: Detector = (dataset, assumptions) => {
  const report = computeInventoryAlerts(dataset, assumptions);
  return report.alerts
    .filter((a) => a.status === 'stockout_risk' && a.lostContributionEstimate > 0)
    .map((a) =>
      leak({
        type: 'stockout_risk',
        subject: a.sku,
        title: `${a.name} runs out ${a.projectedStockoutDate ?? ''}: about ${Math.round(a.stockoutGapDays)} days without stock`,
        monthlyImpact: a.lostContributionEstimate,
        explanation: `${a.reason} Estimated contribution lost during the gap: ${usd(a.lostContributionEstimate)}.`,
        suggestedAction:
          a.inbound.length > 0
            ? `Ask the supplier to expedite ${a.inbound[0]?.poId ?? 'the open PO'} or air-freight a partial shipment; meanwhile pull it from paid ads so spend does not drive traffic to a sold-out page.`
            : `Place a PO for about ${a.recommendedOrderQty} units now and pay for faster freight; pull the SKU from paid ads once cover drops below two weeks.`,
        evidence: {
          onHand: a.onHand,
          dailyVelocity: a.dailyVelocity,
          daysOfCover: a.daysOfCover,
          leadTimeDays: a.leadTimeDays,
          stockoutGapDays: a.stockoutGapDays,
          recommendedOrderQty: a.recommendedOrderQty,
        },
      }),
    );
};

/** Overstocked SKUs: cash tied up in inventory that will not sell for months. */
export const detectDeadStock: Detector = (dataset, assumptions) => {
  const report = computeInventoryAlerts(dataset, assumptions);
  return report.alerts
    .filter((a) => a.status === 'overstock' && a.excessInventoryValue > 0)
    .map((a) =>
      leak({
        type: 'dead_stock',
        subject: a.sku,
        title: `${usd(a.excessInventoryValue)} of cash tied up in excess ${a.name} stock`,
        monthlyImpact: a.monthlyHoldingCostOfExcess,
        explanation:
          `${a.onHand} units on hand at ${a.dailyVelocity.toFixed(1)} units/day is ${Math.round(a.daysOfCover ?? 0)} days of cover. ` +
          `Holding the excess costs about ${usd(a.monthlyHoldingCostOfExcess)} per month (capital, storage, shrink at ${Math.round(assumptions.inventoryHoldingCostAnnualPct * 100)}%/yr), ` +
          `and freeing it would release ${usd(a.excessInventoryValue)} of cash.`,
        suggestedAction: 'Bundle it with a fast mover, run a targeted promotion to past buyers, or liquidate part of the excess; do not reorder.',
        evidence: {
          onHand: a.onHand,
          dailyVelocity: a.dailyVelocity,
          daysOfCover: a.daysOfCover,
          inventoryValue: a.inventoryValue,
          excessInventoryValue: a.excessInventoryValue,
        },
      }),
    );
};

export const DETECTORS: Record<LeakType, Detector> = {
  unprofitable_sku: detectUnprofitableSkus,
  refund_rate_outlier: detectRefundOutliers,
  channel_overspend: detectChannelOverspend,
  discount_code_leak: detectDiscountCodeLeaks,
  stockout_risk: detectStockoutRisk,
  dead_stock: detectDeadStock,
};

export function findProfitLeaks(
  dataset: Dataset,
  assumptions: Assumptions,
  range: DateRange,
  options: { minMonthlyImpact?: number; types?: LeakType[] } = {},
): LeakReport {
  const types = options.types ?? (Object.keys(DETECTORS) as LeakType[]);
  const leaks = types
    .flatMap((type) => DETECTORS[type](dataset, assumptions, range))
    .filter((l) => l.monthlyImpact >= (options.minMonthlyImpact ?? 0))
    .sort((a, b) => b.monthlyImpact - a.monthlyImpact);
  return {
    asOf: dataset.meta.asOf,
    range,
    leaks,
    totalMonthlyImpact: leaks.reduce((a, l) => a + l.monthlyImpact, 0),
    detectorsRun: types,
  };
}

function channelName(channel: Channel): string {
  const names: Record<Channel, string> = {
    meta: 'Meta Ads',
    google: 'Google Ads',
    tiktok: 'TikTok Ads',
    email: 'Email',
    organic: 'Organic',
  };
  return names[channel];
}
