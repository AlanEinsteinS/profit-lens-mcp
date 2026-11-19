import { addDays, dayOfWeek, daysBetween } from '../finance/dates.js';
import { Rng } from './rng.js';
import type {
  AdSpend,
  Channel,
  Dataset,
  InventoryPosition,
  Order,
  OrderLine,
  PaymentGateway,
  Product,
  PurchaseOrder,
} from './types.js';

/**
 * Seeded generator for a realistic, fictional DTC home-goods brand.
 *
 * The data is synthetic but shaped like a real Shopify store export: daily
 * seasonality, a growth trend, channel-specific new/returning mixes, discount
 * codes, refunds that arrive days after the order, carrier and 3PL costs,
 * payment fees and ad spend whose returns diminish with scale.
 *
 * A handful of realistic problems are planted on purpose (see `SCENARIO` below)
 * so the analysis tools have something meaningful to find. The detectors never
 * look at these flags; they work from the raw numbers like they would on real data.
 */

export const DEFAULT_SEED = 42;
export const DEFAULT_AS_OF = '2026-11-15';
export const DEFAULT_HISTORY_DAYS = 180;

export interface GeneratorOptions {
  seed?: number;
  asOf?: string;
  historyDays?: number;
}

interface CatalogEntry extends Product {
  /** Relative demand weight. */
  popularity: number;
  /** Probability that a line is refunded. */
  refundRate: number;
  leadTimeDays: number;
  moq: number;
  casePack: number;
  /** Stock on hand at `asOf`, expressed as days of recent demand. */
  coverDays: number;
  /** Open purchase order, expressed as days of demand and days until arrival. */
  inbound?: { coverDays: number; arrivesInDays: number };
  /** Demand multiplier during the November gifting season. */
  holidayLift?: number;
}

/** The planted problems, documented for humans. Detectors do not read this. */
export const SCENARIO = {
  heavyLowMarginSku: 'AA-PLNT-CI',
  highRefundSku: 'AA-DUV-LIN',
  overstockedSku: 'AA-RUG-JT',
  stockoutRiskSkus: ['AA-GFT-SET', 'AA-VASE-CR'],
  overspendingChannel: 'tiktok' as Channel,
  leakedDiscountCode: 'FRIENDS40',
  /** Days before `asOf` when the TikTok budget was tripled. */
  tiktokRampDays: 28,
  /** Days before `asOf` when the discount code leaked to coupon sites. */
  discountLeakDays: 21,
} as const;

const CATALOG: CatalogEntry[] = [
  { sku: 'AA-CNDL-CED', name: 'Cedar & Smoke Candle', category: 'Candles', price: 38, unitCost: 9.5, weightLb: 1.4, popularity: 14, refundRate: 0.025, leadTimeDays: 60, moq: 500, casePack: 12, coverDays: 88 },
  { sku: 'AA-CNDL-FIG', name: 'Fig Leaf Candle', category: 'Candles', price: 38, unitCost: 9.8, weightLb: 1.4, popularity: 11, refundRate: 0.03, leadTimeDays: 60, moq: 500, casePack: 12, coverDays: 36, inbound: { coverDays: 70, arrivesInDays: 18 } },
  { sku: 'AA-DIFF-01', name: 'Reed Diffuser', category: 'Home Fragrance', price: 44, unitCost: 11, weightLb: 1.1, popularity: 8, refundRate: 0.035, leadTimeDays: 45, moq: 300, casePack: 12, coverDays: 90 },
  { sku: 'AA-THRW-WL', name: 'Wool Throw Blanket', category: 'Textiles', price: 129, unitCost: 41, weightLb: 3.5, popularity: 6, refundRate: 0.05, leadTimeDays: 75, moq: 200, casePack: 10, coverDays: 85 },
  { sku: 'AA-DUV-LIN', name: 'Linen Duvet Cover', category: 'Textiles', price: 189, unitCost: 58, weightLb: 4.2, popularity: 5, refundRate: 0.17, leadTimeDays: 75, moq: 200, casePack: 10, coverDays: 120 },
  { sku: 'AA-PLNT-CI', name: 'Cast Iron Planter', category: 'Garden', price: 54, unitCost: 24, weightLb: 11, popularity: 7, refundRate: 0.07, leadTimeDays: 50, moq: 300, casePack: 6, coverDays: 75 },
  { sku: 'AA-MUG-ST', name: 'Stoneware Mug Set', category: 'Kitchen', price: 56, unitCost: 15, weightLb: 3, popularity: 7, refundRate: 0.06, leadTimeDays: 40, moq: 300, casePack: 8, coverDays: 50 },
  { sku: 'AA-TRAY-WD', name: 'Walnut Serving Tray', category: 'Kitchen', price: 72, unitCost: 22, weightLb: 2.2, popularity: 5, refundRate: 0.03, leadTimeDays: 55, moq: 200, casePack: 10, coverDays: 125 },
  { sku: 'AA-SOAP-3P', name: 'Botanical Soap 3-Pack', category: 'Bath', price: 24, unitCost: 5.5, weightLb: 0.9, popularity: 12, refundRate: 0.02, leadTimeDays: 30, moq: 1000, casePack: 24, coverDays: 120 },
  { sku: 'AA-GFT-SET', name: 'Candle Gift Set', category: 'Gifts', price: 89, unitCost: 24, weightLb: 3.2, popularity: 6, refundRate: 0.03, leadTimeDays: 35, moq: 300, casePack: 6, coverDays: 24, holidayLift: 1.6 },
  { sku: 'AA-RUG-JT', name: 'Jute Runner Rug', category: 'Textiles', price: 149, unitCost: 62, weightLb: 7, popularity: 1.2, refundRate: 0.04, leadTimeDays: 70, moq: 100, casePack: 4, coverDays: 520 },
  { sku: 'AA-VASE-CR', name: 'Ceramic Bud Vase', category: 'Decor', price: 32, unitCost: 8, weightLb: 1, popularity: 13, refundRate: 0.03, leadTimeDays: 45, moq: 500, casePack: 12, coverDays: 24, inbound: { coverDays: 45, arrivesInDays: 30 } },
];

interface ChannelProfile {
  /** Orders per day at baseline. */
  baseOrders: number;
  /** Ad spend per day at baseline (0 for owned channels). */
  baseSpend: number;
  /** Orders scale with (spend / baseSpend) ^ elasticity: diminishing returns. */
  elasticity: number;
  newCustomerRate: number;
}

const CHANNEL_PROFILES: Record<Channel, ChannelProfile> = {
  meta: { baseOrders: 38, baseSpend: 1150, elasticity: 0.8, newCustomerRate: 0.6 },
  google: { baseOrders: 26, baseSpend: 620, elasticity: 0.7, newCustomerRate: 0.55 },
  tiktok: { baseOrders: 9, baseSpend: 260, elasticity: 0.2, newCustomerRate: 0.75 },
  email: { baseOrders: 21, baseSpend: 0, elasticity: 0, newCustomerRate: 0.08 },
  organic: { baseOrders: 24, baseSpend: 0, elasticity: 0, newCustomerRate: 0.35 },
};

/** Sunday .. Saturday demand multipliers. */
const WEEKDAY_FACTOR = [1.05, 1.1, 1.0, 0.97, 0.95, 0.9, 0.95] as const;

export const SHIPPING_RULES = {
  freeShippingThreshold: 75,
  flatRate: 6.95,
  carrierBase: 5.4,
  carrierPerLb: 0.92,
  oversizeWeightLb: 8,
  oversizeSurchargePerUnit: 8.5,
} as const;

export const FULFILLMENT_RULES = {
  perOrder: 3.1,
  packagingPerOrder: 0.85,
  perAdditionalUnit: 0.65,
} as const;

export const PAYMENT_RULES: Record<PaymentGateway, { pct: number; fixed: number }> = {
  shopify_payments: { pct: 0.029, fixed: 0.3 },
  paypal: { pct: 0.0349, fixed: 0.49 },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function generateDataset(options: GeneratorOptions = {}): Dataset {
  const seed = options.seed ?? DEFAULT_SEED;
  const asOf = options.asOf ?? DEFAULT_AS_OF;
  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS;
  const rng = new Rng(seed);
  const startDate = addDays(asOf, -(historyDays - 1));

  const orders: Order[] = [];
  const adSpend: AdSpend[] = [];
  const customers: string[] = [];
  let orderSeq = 10000;

  for (let d = 0; d < historyDays; d += 1) {
    const date = addDays(startDate, d);
    const daysBeforeAsOf = historyDays - 1 - d;
    const trend = 1 + 0.12 * (d / historyDays);
    const holiday = date.slice(5, 7) === '11' ? 1.12 : 1;
    const weekday = WEEKDAY_FACTOR[dayOfWeek(date)] ?? 1;
    const demand = trend * holiday * weekday;

    for (const channel of Object.keys(CHANNEL_PROFILES) as Channel[]) {
      const profile = CHANNEL_PROFILES[channel];
      let orderMean = profile.baseOrders * demand;

      if (profile.baseSpend > 0) {
        const ramp =
          channel === SCENARIO.overspendingChannel && daysBeforeAsOf < SCENARIO.tiktokRampDays ? 3 : 1;
        const plannedSpend = profile.baseSpend * trend * ramp;
        const spend = round2(plannedSpend * rng.noise(0.08));
        adSpend.push({ date, channel, spend });
        orderMean *= Math.pow(spend / (profile.baseSpend * trend), profile.elasticity);
      }

      const count = rng.poisson(orderMean);
      for (let i = 0; i < count; i += 1) {
        orderSeq += 1;
        const isNew = customers.length === 0 || rng.chance(profile.newCustomerRate);
        let customerId: string;
        if (isNew) {
          customerId = `C${String(customers.length + 1).padStart(6, '0')}`;
          customers.push(customerId);
        } else {
          customerId = rng.pick(customers);
        }
        orders.push(
          buildOrder(rng, {
            id: `#${orderSeq}`,
            date,
            asOf,
            channel,
            customerId,
            isNew,
            discountLeakActive: daysBeforeAsOf < SCENARIO.discountLeakDays,
            isHolidaySeason: holiday > 1,
          }),
        );
      }
    }
  }

  const inventory: InventoryPosition[] = [];
  const purchaseOrders: PurchaseOrder[] = [];
  const recentUnits = unitsSoldLastDays(orders, asOf, 28);
  let poSeq = 4100;

  for (const entry of CATALOG) {
    const velocity = (recentUnits.get(entry.sku) ?? 0) / 28;
    inventory.push({
      sku: entry.sku,
      onHand: Math.round(entry.coverDays * velocity),
      leadTimeDays: entry.leadTimeDays,
      moq: entry.moq,
      casePack: entry.casePack,
    });
    if (entry.inbound) {
      poSeq += 1;
      const expectedArrival = addDays(asOf, entry.inbound.arrivesInDays);
      const qty = Math.ceil((entry.inbound.coverDays * velocity) / entry.casePack) * entry.casePack;
      purchaseOrders.push({
        id: `PO-${poSeq}`,
        sku: entry.sku,
        qty: Math.max(qty, entry.moq),
        unitCost: entry.unitCost,
        orderedOn: addDays(expectedArrival, -entry.leadTimeDays),
        expectedArrival,
        depositPaidPct: 0.3,
      });
    }
  }

  return {
    meta: { storeName: 'Alder & Ash (fictional demo store)', currency: 'USD', seed, startDate, asOf },
    products: CATALOG.map(({ sku, name, category, price, unitCost, weightLb }) => ({
      sku,
      name,
      category,
      price,
      unitCost,
      weightLb,
    })),
    orders,
    adSpend,
    inventory,
    purchaseOrders,
  };
}

interface OrderContext {
  id: string;
  date: string;
  asOf: string;
  channel: Channel;
  customerId: string;
  isNew: boolean;
  discountLeakActive: boolean;
  isHolidaySeason: boolean;
}

function buildOrder(rng: Rng, ctx: OrderContext): Order {
  const lineCount = rng.weighted([
    [1, 70],
    [2, 24],
    [3, 6],
  ] as const);

  const weights = CATALOG.map(
    (entry) => [entry, entry.popularity * (ctx.isHolidaySeason ? (entry.holidayLift ?? 1) : 1)] as const,
  );
  const chosen = new Set<CatalogEntry>();
  while (chosen.size < lineCount) chosen.add(rng.weighted(weights));

  const discountCode = pickDiscountCode(rng, ctx);
  const discountPct = discountCode ? (DISCOUNT_CODES[discountCode] ?? 0) : 0;

  let subtotal = 0;
  let totalWeight = 0;
  let totalUnits = 0;
  let oversizeUnits = 0;
  const lines: OrderLine[] = [];
  for (const entry of chosen) {
    const qty = rng.weighted([
      [1, 88],
      [2, 10],
      [3, 2],
    ] as const);
    const gross = entry.price * qty;
    const discount = round2(gross * discountPct);
    subtotal += gross - discount;
    totalWeight += entry.weightLb * qty;
    totalUnits += qty;
    if (entry.weightLb >= SHIPPING_RULES.oversizeWeightLb) oversizeUnits += qty;

    let refundedQty = 0;
    let refundAmount = 0;
    if (rng.chance(entry.refundRate)) {
      const refundDate = addDays(ctx.date, rng.int(4, 30));
      if (daysBetween(refundDate, ctx.asOf) >= 0) {
        refundedQty = qty;
        refundAmount = round2(gross - discount);
      }
    }
    lines.push({ sku: entry.sku, qty, unitPrice: entry.price, discount, refundedQty, refundAmount });
  }

  const shippingCharged = subtotal >= SHIPPING_RULES.freeShippingThreshold ? 0 : SHIPPING_RULES.flatRate;
  const shippingCost = round2(
    (SHIPPING_RULES.carrierBase + SHIPPING_RULES.carrierPerLb * totalWeight) * rng.noise(0.04) +
      SHIPPING_RULES.oversizeSurchargePerUnit * oversizeUnits,
  );
  const fulfillmentCost = round2(
    FULFILLMENT_RULES.perOrder +
      FULFILLMENT_RULES.packagingPerOrder +
      FULFILLMENT_RULES.perAdditionalUnit * (totalUnits - 1),
  );
  const gateway: PaymentGateway = rng.chance(0.18) ? 'paypal' : 'shopify_payments';
  const fee = PAYMENT_RULES[gateway];
  const paymentFee = round2((subtotal + shippingCharged) * fee.pct + fee.fixed);

  return {
    id: ctx.id,
    date: ctx.date,
    customerId: ctx.customerId,
    isNewCustomer: ctx.isNew,
    channel: ctx.channel,
    discountCode,
    gateway,
    lines,
    shippingCharged,
    shippingCost,
    fulfillmentCost,
    paymentFee,
  };
}

const DISCOUNT_CODES: Record<string, number> = {
  WELCOME10: 0.1,
  VIP15: 0.15,
  FRIENDS40: 0.4,
};

function pickDiscountCode(rng: Rng, ctx: OrderContext): string | null {
  const leakRate = ctx.discountLeakActive ? (ctx.channel === 'organic' ? 0.3 : 0.06) : 0.003;
  if (rng.chance(leakRate)) return SCENARIO.leakedDiscountCode;
  if (ctx.isNew && rng.chance(0.18)) return 'WELCOME10';
  if (!ctx.isNew && ctx.channel === 'email' && rng.chance(0.25)) return 'VIP15';
  return null;
}

function unitsSoldLastDays(orders: Order[], asOf: string, days: number): Map<string, number> {
  const from = addDays(asOf, -(days - 1));
  const units = new Map<string, number>();
  for (const order of orders) {
    if (order.date < from || order.date > asOf) continue;
    for (const line of order.lines) units.set(line.sku, (units.get(line.sku) ?? 0) + line.qty);
  }
  return units;
}
