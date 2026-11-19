import { PAID_CHANNELS, type Dataset } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { addDays, daysBetween, inRange, trailingRange } from './dates.js';
import { computeSkuDemand, roundOrderQty } from './inventory.js';

export interface ForecastScenario {
  /** Number of weeks to project (13 = one quarter, the classic treasury horizon). */
  weeks: number;
  /** Change in paid media budget vs the trailing run-rate, in percent (e.g. -20). */
  adSpendChangePct: number;
  /** Organic week-over-week demand growth, in percent. */
  weeklyGrowthPct: number;
  /** Overrides `assumptions.startingCash` when provided. */
  startingCash?: number | undefined;
}

export const DEFAULT_SCENARIO: ForecastScenario = { weeks: 13, adSpendChangePct: 0, weeklyGrowthPct: 0 };

export interface ForecastWeek {
  week: number;
  weekStart: string;
  weekEnd: string;
  openingCash: number;
  cashIn: number;
  adSpend: number;
  /** Shipping, 3PL fulfillment and payment fees. */
  variableCosts: number;
  opex: number;
  inventoryPurchases: number;
  netCashFlow: number;
  closingCash: number;
  belowBuffer: boolean;
}

export interface ProjectedPurchaseOrder {
  sku: string;
  orderDate: string;
  expectedArrival: string;
  qty: number;
  value: number;
}

export interface ProjectedStockout {
  sku: string;
  firstStockoutDate: string;
  daysOutOfStock: number;
  lostRevenue: number;
}

export interface CashForecast {
  asOf: string;
  scenario: ForecastScenario;
  baseline: {
    windowDays: number;
    dailyCashIn: number;
    dailyAdSpend: number;
    /** Variable costs as a share of cash collected. */
    variableCostRatio: number;
    /** Share of revenue attributed to paid channels. */
    paidRevenueShare: number;
    /** Demand multiplier implied by the ad spend change. */
    revenueMultiplier: number;
  };
  weeks: ForecastWeek[];
  summary: {
    startingCash: number;
    endingCash: number;
    lowestClosingCash: number;
    lowestCashWeek: number;
    minCashBuffer: number;
    weeksBelowBuffer: number[];
    totalCashIn: number;
    totalAdSpend: number;
    totalVariableCosts: number;
    totalOpex: number;
    totalInventoryPurchases: number;
    /** PO balances that fall due after the forecast horizon. */
    inventoryCommitmentsBeyondHorizon: number;
  };
  projectedPurchaseOrders: ProjectedPurchaseOrder[];
  projectedStockouts: ProjectedStockout[];
}

const BASELINE_WINDOW_DAYS = 28;

interface SimSku {
  sku: string;
  unitCost: number;
  onHand: number;
  baseVelocity: number;
  netRevenuePerUnit: number;
  leadTimeDays: number;
  moq: number;
  casePack: number;
  /** Units ordered but not yet received, keyed by arrival day index. */
  arrivals: Map<number, { qty: number; balanceDue: number }[]>;
  pendingQty: number;
  stockout: { firstDay: number; days: number; lostRevenue: number } | null;
}

/**
 * Direct-method 13-week cash forecast.
 *
 * Cash in and variable costs run at the trailing 28-day rate, adjusted by the
 * scenario. Inventory is simulated day by day per SKU: open POs land on their
 * dates (balance paid on arrival), and whenever stock plus inbound falls to
 * the reorder point a new PO is placed (deposit now, balance on arrival).
 * Days without stock reduce cash in, so a stockout shows up in the forecast.
 */
export function forecastCash13Weeks(
  dataset: Dataset,
  assumptions: Assumptions,
  scenario: ForecastScenario = DEFAULT_SCENARIO,
): CashForecast {
  const asOf = dataset.meta.asOf;
  const window = trailingRange(asOf, BASELINE_WINDOW_DAYS);

  let cashIn = 0;
  let variable = 0;
  let paidRevenue = 0;
  let revenue = 0;
  for (const order of dataset.orders) {
    if (!inRange(order.date, window)) continue;
    const orderRevenue = order.lines.reduce((a, l) => a + l.unitPrice * l.qty - l.discount, 0);
    const refunds = order.lines.reduce((a, l) => a + l.refundAmount, 0);
    cashIn += orderRevenue + order.shippingCharged - refunds;
    variable += order.shippingCost + order.fulfillmentCost + order.paymentFee;
    revenue += orderRevenue;
    if (PAID_CHANNELS.includes(order.channel)) paidRevenue += orderRevenue;
  }
  const adSpendWindow = dataset.adSpend.filter((r) => inRange(r.date, window)).reduce((a, r) => a + r.spend, 0);

  const dailyCashIn = cashIn / BASELINE_WINDOW_DAYS;
  const dailyAdSpend = adSpendWindow / BASELINE_WINDOW_DAYS;
  const variableCostRatio = cashIn > 0 ? variable / cashIn : 0;
  const paidRevenueShare = revenue > 0 ? paidRevenue / revenue : 0;
  const revenueMultiplier = Math.max(
    0,
    1 + paidRevenueShare * assumptions.paidRevenueElasticity * (scenario.adSpendChangePct / 100),
  );

  const demand = computeSkuDemand(dataset, assumptions, BASELINE_WINDOW_DAYS);
  const unitCosts = new Map(dataset.products.map((p) => [p.sku, p.unitCost]));
  const sims: SimSku[] = dataset.inventory.map((pos) => {
    const d = demand.get(pos.sku);
    const sim: SimSku = {
      sku: pos.sku,
      unitCost: unitCosts.get(pos.sku) ?? 0,
      onHand: pos.onHand,
      baseVelocity: d?.dailyVelocity ?? 0,
      netRevenuePerUnit: d?.netRevenuePerUnit ?? 0,
      leadTimeDays: pos.leadTimeDays,
      moq: pos.moq,
      casePack: pos.casePack,
      arrivals: new Map(),
      pendingQty: 0,
      stockout: null,
    };
    for (const po of dataset.purchaseOrders) {
      if (po.sku !== pos.sku || po.expectedArrival <= asOf) continue;
      const day = daysBetween(asOf, po.expectedArrival);
      const list = sim.arrivals.get(day) ?? [];
      list.push({ qty: po.qty, balanceDue: po.qty * po.unitCost * (1 - po.depositPaidPct) });
      sim.arrivals.set(day, list);
      sim.pendingQty += po.qty;
    }
    return sim;
  });

  const startingCash = scenario.startingCash ?? assumptions.startingCash;
  const opexPerWeek = (assumptions.monthlyOpex * 12) / 52;
  const horizonDays = scenario.weeks * 7;
  const weeklyGrowth = scenario.weeklyGrowthPct / 100;
  const baselineRevenuePerDay = sims.reduce((a, s) => a + s.baseVelocity * s.netRevenuePerUnit, 0);

  const projectedPurchaseOrders: ProjectedPurchaseOrder[] = [];
  const weeks: ForecastWeek[] = [];
  let cash = startingCash;
  let beyondHorizon = 0;
  let lowest = { closingCash: Infinity, week: 0 };

  for (let w = 0; w < scenario.weeks; w += 1) {
    const week: ForecastWeek = {
      week: w + 1,
      weekStart: addDays(asOf, w * 7 + 1),
      weekEnd: addDays(asOf, w * 7 + 7),
      openingCash: cash,
      cashIn: 0,
      adSpend: 0,
      variableCosts: 0,
      opex: opexPerWeek,
      inventoryPurchases: 0,
      netCashFlow: 0,
      closingCash: 0,
      belowBuffer: false,
    };

    for (let dow = 1; dow <= 7; dow += 1) {
      const day = w * 7 + dow;
      const demandFactor = revenueMultiplier * Math.pow(1 + weeklyGrowth, day / 7);
      let lostRevenue = 0;

      for (const sim of sims) {
        for (const arrival of sim.arrivals.get(day) ?? []) {
          sim.onHand += arrival.qty;
          sim.pendingQty -= arrival.qty;
          week.inventoryPurchases += arrival.balanceDue;
        }

        const velocity = sim.baseVelocity * demandFactor;
        const sold = Math.min(sim.onHand, velocity);
        sim.onHand -= sold;
        const lost = velocity - sold;
        if (lost > 1e-9) {
          const lostRev = lost * sim.netRevenuePerUnit;
          lostRevenue += lostRev;
          sim.stockout ??= { firstDay: day, days: 0, lostRevenue: 0 };
          sim.stockout.days += lost / velocity;
          sim.stockout.lostRevenue += lostRev;
        }

        const reorderPoint = velocity * (sim.leadTimeDays + assumptions.safetyStockDays);
        const position = sim.onHand + sim.pendingQty;
        if (velocity > 0 && position <= reorderPoint) {
          const desired =
            velocity * (sim.leadTimeDays + assumptions.safetyStockDays + assumptions.targetCoverDays) - position;
          const qty = roundOrderQty(desired, sim);
          const value = qty * sim.unitCost;
          const arrivalDay = day + sim.leadTimeDays;
          week.inventoryPurchases += value * assumptions.poDepositPct;
          const balanceDue = value * (1 - assumptions.poDepositPct);
          if (arrivalDay > horizonDays) beyondHorizon += balanceDue;
          const list = sim.arrivals.get(arrivalDay) ?? [];
          list.push({ qty, balanceDue });
          sim.arrivals.set(arrivalDay, list);
          sim.pendingQty += qty;
          projectedPurchaseOrders.push({
            sku: sim.sku,
            orderDate: addDays(asOf, day),
            expectedArrival: addDays(asOf, arrivalDay),
            qty,
            value,
          });
        }
      }

      const plannedRevenue = baselineRevenuePerDay * demandFactor;
      const fulfilledShare = plannedRevenue > 0 ? Math.max(0, 1 - lostRevenue / plannedRevenue) : 1;
      const dayCashIn = dailyCashIn * demandFactor * fulfilledShare;
      week.cashIn += dayCashIn;
      week.variableCosts += dayCashIn * variableCostRatio;
      week.adSpend += dailyAdSpend * (1 + scenario.adSpendChangePct / 100);
    }

    week.netCashFlow = week.cashIn - week.adSpend - week.variableCosts - week.opex - week.inventoryPurchases;
    cash += week.netCashFlow;
    week.closingCash = cash;
    week.belowBuffer = cash < assumptions.minCashBuffer;
    if (cash < lowest.closingCash) lowest = { closingCash: cash, week: week.week };
    weeks.push(week);
  }

  const total = (pick: (w: ForecastWeek) => number): number => weeks.reduce((a, w) => a + pick(w), 0);

  return {
    asOf,
    scenario: { ...scenario, startingCash },
    baseline: {
      windowDays: BASELINE_WINDOW_DAYS,
      dailyCashIn,
      dailyAdSpend,
      variableCostRatio,
      paidRevenueShare,
      revenueMultiplier,
    },
    weeks,
    summary: {
      startingCash,
      endingCash: cash,
      lowestClosingCash: lowest.closingCash,
      lowestCashWeek: lowest.week,
      minCashBuffer: assumptions.minCashBuffer,
      weeksBelowBuffer: weeks.filter((w) => w.belowBuffer).map((w) => w.week),
      totalCashIn: total((w) => w.cashIn),
      totalAdSpend: total((w) => w.adSpend),
      totalVariableCosts: total((w) => w.variableCosts),
      totalOpex: total((w) => w.opex),
      totalInventoryPurchases: total((w) => w.inventoryPurchases),
      inventoryCommitmentsBeyondHorizon: beyondHorizon,
    },
    projectedPurchaseOrders,
    projectedStockouts: sims
      .filter((s) => s.stockout !== null)
      .map((s) => ({
        sku: s.sku,
        firstStockoutDate: addDays(asOf, s.stockout?.firstDay ?? 0),
        daysOutOfStock: s.stockout?.days ?? 0,
        lostRevenue: s.stockout?.lostRevenue ?? 0,
      }))
      .sort((a, b) => b.lostRevenue - a.lostRevenue),
  };
}
