import type { Channel, Dataset, Order, Product } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { inRange, type DateRange } from './dates.js';

/**
 * The economics of one order line, with every order-level cost allocated down
 * to the line. Every report (SKU margins, channel P&L, leaks) is a different
 * grouping of these rows, so all of them reconcile with each other.
 *
 * Allocation rules:
 * - Shipping (carrier cost minus shipping charged) is allocated by line weight.
 * - Fulfillment (3PL pick/pack) is allocated by units.
 * - Payment fees are allocated by line revenue after discounts.
 * - COGS of refunded units is recovered at `refundRestockRate`.
 */
export interface LineEconomics {
  orderId: string;
  date: string;
  channel: Channel;
  discountCode: string | null;
  isNewCustomer: boolean;
  sku: string;
  units: number;
  refundedUnits: number;
  grossRevenue: number;
  discounts: number;
  refunds: number;
  /** Gross revenue minus discounts minus refunds. */
  netRevenue: number;
  cogs: number;
  /** Carrier cost minus shipping charged to the customer (positive = subsidy). */
  shippingNet: number;
  fulfillment: number;
  paymentFees: number;
}

export interface ContributionMargins {
  /** Net revenue minus COGS (gross margin). */
  cm1: number;
  /** CM1 minus shipping, fulfillment and payment fees. */
  cm2: number;
}

export function contribution(row: Pick<LineEconomics, 'netRevenue' | 'cogs' | 'shippingNet' | 'fulfillment' | 'paymentFees'>): ContributionMargins {
  const cm1 = row.netRevenue - row.cogs;
  const cm2 = cm1 - row.shippingNet - row.fulfillment - row.paymentFees;
  return { cm1, cm2 };
}

export function orderLineEconomics(
  order: Order,
  products: ReadonlyMap<string, Product>,
  assumptions: Pick<Assumptions, 'refundRestockRate'>,
): LineEconomics[] {
  const weights = order.lines.map((line) => (products.get(line.sku)?.weightLb ?? 0) * line.qty);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalUnits = order.lines.reduce((a, l) => a + l.qty, 0);
  const totalRevenue = order.lines.reduce((a, l) => a + l.unitPrice * l.qty - l.discount, 0);
  const shippingNetTotal = order.shippingCost - order.shippingCharged;

  return order.lines.map((line, i) => {
    const product = products.get(line.sku);
    if (!product) throw new Error(`Unknown SKU ${line.sku} in order ${order.id}`);
    const gross = line.unitPrice * line.qty;
    const lineRevenue = gross - line.discount;
    const weightShare = totalWeight > 0 ? (weights[i] ?? 0) / totalWeight : 1 / order.lines.length;
    const revenueShare = totalRevenue > 0 ? lineRevenue / totalRevenue : 1 / order.lines.length;
    const unitShare = totalUnits > 0 ? line.qty / totalUnits : 1 / order.lines.length;
    const unitsSold = line.qty - line.refundedQty * assumptions.refundRestockRate;

    return {
      orderId: order.id,
      date: order.date,
      channel: order.channel,
      discountCode: order.discountCode,
      isNewCustomer: order.isNewCustomer,
      sku: line.sku,
      units: line.qty,
      refundedUnits: line.refundedQty,
      grossRevenue: gross,
      discounts: line.discount,
      refunds: line.refundAmount,
      netRevenue: lineRevenue - line.refundAmount,
      cogs: product.unitCost * unitsSold,
      shippingNet: shippingNetTotal * weightShare,
      fulfillment: order.fulfillmentCost * unitShare,
      paymentFees: order.paymentFee * revenueShare,
    };
  });
}

/** Economics rows for every order line whose order date falls in `range`. */
export function lineEconomicsInRange(dataset: Dataset, assumptions: Assumptions, range: DateRange): LineEconomics[] {
  const products = productMap(dataset);
  const rows: LineEconomics[] = [];
  for (const order of dataset.orders) {
    if (inRange(order.date, range)) rows.push(...orderLineEconomics(order, products, assumptions));
  }
  return rows;
}

export function productMap(dataset: Dataset): Map<string, Product> {
  return new Map(dataset.products.map((p) => [p.sku, p]));
}

export function adSpendByChannel(dataset: Dataset, range: DateRange): Map<Channel, number> {
  const totals = new Map<Channel, number>();
  for (const row of dataset.adSpend) {
    if (inRange(row.date, range)) totals.set(row.channel, (totals.get(row.channel) ?? 0) + row.spend);
  }
  return totals;
}

/** Summable money fields of `LineEconomics`. */
export const MONEY_FIELDS = [
  'grossRevenue',
  'discounts',
  'refunds',
  'netRevenue',
  'cogs',
  'shippingNet',
  'fulfillment',
  'paymentFees',
] as const;

export type MoneyTotals = Record<(typeof MONEY_FIELDS)[number], number> & { units: number; refundedUnits: number };

export function emptyTotals(): MoneyTotals {
  return {
    units: 0,
    refundedUnits: 0,
    grossRevenue: 0,
    discounts: 0,
    refunds: 0,
    netRevenue: 0,
    cogs: 0,
    shippingNet: 0,
    fulfillment: 0,
    paymentFees: 0,
  };
}

export function addInto(target: MoneyTotals, row: LineEconomics): void {
  target.units += row.units;
  target.refundedUnits += row.refundedUnits;
  for (const field of MONEY_FIELDS) target[field] += row[field];
}

/** Percentage helper that never divides by zero. */
export function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
