import { describe, expect, it } from 'vitest';
import type { InventoryPosition, PurchaseOrder } from '../src/data/types.js';
import { resolveAssumptions } from '../src/finance/assumptions.js';
import { addDays } from '../src/finance/dates.js';
import { forecastCash13Weeks } from '../src/finance/forecast.js';
import { computeInventoryAlerts, evaluateReorder, roundOrderQty } from '../src/finance/inventory.js';
import { line, makeDataset, order, spend } from './fixtures.js';

const assumptions = resolveAssumptions({
  safetyStockDays: 14,
  targetCoverDays: 60,
  overstockDays: 180,
  poDepositPct: 0.3,
  monthlyOpex: 5200,
  startingCash: 10_000,
  minCashBuffer: 5_000,
  paidRevenueElasticity: 0.6,
});

const pack = { moq: 1, casePack: 1 };

describe('roundOrderQty', () => {
  it('rounds up to the case pack and respects the MOQ', () => {
    expect(roundOrderQty(0, { moq: 100, casePack: 12 })).toBe(0);
    expect(roundOrderQty(-5, { moq: 100, casePack: 12 })).toBe(0);
    expect(roundOrderQty(13, { moq: 1, casePack: 12 })).toBe(24);
    expect(roundOrderQty(13, { moq: 100, casePack: 12 })).toBe(108); // MOQ 100 rounded up to whole cases
    expect(roundOrderQty(500, { moq: 100, casePack: 12 })).toBe(504);
  });
});

describe('evaluateReorder', () => {
  const base = { inboundQty: 0, daysToFirstInbound: null, dailyVelocity: 10, leadTimeDays: 30 };

  it('is healthy when stock covers lead time plus safety stock', () => {
    const r = evaluateReorder({ ...base, onHand: 1000 }, assumptions, pack);
    expect(r.status).toBe('healthy');
    expect(r.daysOfCover).toBe(100);
    expect(r.reorderPoint).toBe(440);
    expect(r.recommendedOrderQty).toBe(0);
  });

  it('asks to reorder at or below the reorder point', () => {
    const r = evaluateReorder({ ...base, onHand: 400 }, assumptions, pack);
    expect(r.status).toBe('reorder_now');
    // cover lead + safety + target = 10 * (30 + 14 + 60) = 1040, minus 400 on hand
    expect(r.recommendedOrderQty).toBe(640);
  });

  it('counts inbound stock in the inventory position', () => {
    const r = evaluateReorder({ ...base, onHand: 400, inboundQty: 600, daysToFirstInbound: 10 }, assumptions, pack);
    expect(r.inventoryPosition).toBe(1000);
    expect(r.status).toBe('healthy');
  });

  it('flags stockout risk when stock runs out before a new PO could land', () => {
    const r = evaluateReorder({ ...base, onHand: 200 }, assumptions, pack);
    expect(r.status).toBe('stockout_risk');
    expect(r.stockoutGapDays).toBe(10); // 20 days of cover vs 30-day lead time
    expect(r.recommendedOrderQty).toBe(840);
  });

  it('flags stockout risk when the open PO lands after the stock runs out', () => {
    const r = evaluateReorder({ ...base, onHand: 200, inboundQty: 2000, daysToFirstInbound: 25 }, assumptions, pack);
    expect(r.status).toBe('stockout_risk');
    expect(r.stockoutGapDays).toBe(5);
  });

  it('flags overstock above the threshold and measures the excess', () => {
    const r = evaluateReorder({ ...base, onHand: 2500 }, assumptions, pack);
    expect(r.status).toBe('overstock');
    expect(r.excessUnits).toBe(2500 - 1800);
  });

  it('treats stock with no sales as overstock', () => {
    const r = evaluateReorder({ ...base, dailyVelocity: 0, onHand: 50 }, assumptions, pack);
    expect(r.status).toBe('overstock');
    expect(r.daysOfCover).toBeNull();
  });
});

/** One $100 widget sold per day for the 28 days before as-of, $10/day of Meta spend, no variable costs. */
function steadyStore(inventory: InventoryPosition[], purchaseOrders: PurchaseOrder[] = []) {
  const asOf = '2026-01-31';
  const orders = Array.from({ length: 28 }, (_, i) => order({ date: addDays(asOf, -i), channel: 'meta', lines: [line('W', 1, 100)] }));
  const adSpend = Array.from({ length: 28 }, (_, i) => spend(addDays(asOf, -i), 'meta', 10));
  return makeDataset({ orders, adSpend, inventory, purchaseOrders });
}

describe('computeInventoryAlerts', () => {
  it('values stock, estimates lost contribution and sorts by urgency', () => {
    const ds = steadyStore([
      { sku: 'W', onHand: 5, leadTimeDays: 20, ...pack },
      { sku: 'A', onHand: 10, leadTimeDays: 20, ...pack },
    ]);
    const report = computeInventoryAlerts(ds, assumptions);
    const [first, second] = report.alerts;
    expect(first?.sku).toBe('W');
    expect(first?.status).toBe('stockout_risk');
    expect(first?.stockoutGapDays).toBe(15);
    // CM2 per widget = 100 - 40 COGS = 60; 15 days x 1/day x 60
    expect(first?.lostContributionEstimate).toBeCloseTo(900);
    expect(first?.projectedStockoutDate).toBe('2026-02-05');
    expect(second?.status).toBe('overstock'); // anvil never sells
    expect(report.summary.totalInventoryValue).toBe(5 * 40 + 10 * 20);
  });
});

describe('forecastCash13Weeks', () => {
  const healthy: InventoryPosition[] = [{ sku: 'W', onHand: 1000, leadTimeDays: 10, ...pack }];

  it('rolls cash forward week by week from the trailing run-rate', () => {
    const f = forecastCash13Weeks(steadyStore(healthy), assumptions);
    expect(f.weeks).toHaveLength(13);
    const [w1] = f.weeks;
    expect(w1?.weekStart).toBe('2026-02-01');
    expect(w1?.cashIn).toBeCloseTo(700);
    expect(w1?.adSpend).toBeCloseTo(70);
    expect(w1?.opex).toBeCloseTo(1200);
    expect(w1?.netCashFlow).toBeCloseTo(700 - 70 - 1200);
    for (const w of f.weeks) expect(w.closingCash).toBeCloseTo(w.openingCash + w.netCashFlow);
    expect(f.summary.endingCash).toBeCloseTo(10_000 - 13 * 570);
    expect(f.summary.lowestCashWeek).toBe(13);
    expect(f.summary.weeksBelowBuffer).toEqual([9, 10, 11, 12, 13]); // 10,000 - 9 x 570 = 4,870 < 5,000
  });

  it('applies the ad spend scenario to spend and, through elasticity, to revenue', () => {
    const f = forecastCash13Weeks(steadyStore(healthy), assumptions, { weeks: 4, adSpendChangePct: -50, weeklyGrowthPct: 0 });
    expect(f.weeks).toHaveLength(4);
    expect(f.baseline.paidRevenueShare).toBe(1);
    expect(f.baseline.revenueMultiplier).toBeCloseTo(0.7);
    expect(f.weeks[0]?.adSpend).toBeCloseTo(35);
    expect(f.weeks[0]?.cashIn).toBeCloseTo(490);
  });

  it('pays the open PO balance in its arrival week', () => {
    const po: PurchaseOrder = {
      id: 'PO-1',
      sku: 'W',
      qty: 50,
      unitCost: 40,
      orderedOn: '2026-01-01',
      expectedArrival: '2026-02-10',
      depositPaidPct: 0.3,
    };
    const f = forecastCash13Weeks(steadyStore(healthy, [po]), assumptions);
    expect(f.weeks[1]?.inventoryPurchases).toBeCloseTo(50 * 40 * 0.7);
    expect(f.summary.totalInventoryPurchases).toBeCloseTo(1400);
  });

  it('places reorders, pays the deposit now and the balance on arrival, and loses sales while out of stock', () => {
    const f = forecastCash13Weeks(steadyStore([{ sku: 'W', onHand: 3, leadTimeDays: 100, ...pack }]), assumptions);
    expect(f.projectedPurchaseOrders).toHaveLength(1);
    const [po] = f.projectedPurchaseOrders;
    // Reviewed at end of day 1, after selling one unit: 1/day x (100 + 14 + 60) - 2 on hand
    expect(po?.qty).toBe(172);
    expect(f.weeks[0]?.inventoryPurchases).toBeCloseTo(172 * 40 * 0.3);
    expect(f.summary.inventoryCommitmentsBeyondHorizon).toBeCloseTo(172 * 40 * 0.7);
    expect(f.projectedStockouts[0]?.firstStockoutDate).toBe('2026-02-04');
    expect(f.weeks[0]?.cashIn).toBeCloseTo(300); // only 3 units left to sell
    expect(f.weeks[1]?.cashIn).toBeCloseTo(0);
  });
});
