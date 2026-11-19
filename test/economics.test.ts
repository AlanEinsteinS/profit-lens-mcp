import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSUMPTIONS } from '../src/finance/assumptions.js';
import { contribution, lineEconomicsInRange, orderLineEconomics, pct, ratio } from '../src/finance/economics.js';
import { ANVIL, WIDGET, line, makeDataset, order } from './fixtures.js';

const products = new Map([
  [WIDGET.sku, WIDGET],
  [ANVIL.sku, ANVIL],
]);

describe('orderLineEconomics', () => {
  // Widget: 1 x $100, weight 1 lb. Anvil: 2 x $50 with $10 discount, weight 6 lb total.
  const o = order({
    lines: [line('W', 1, 100), line('A', 2, 50, { discount: 10 })],
    shippingCharged: 7,
    shippingCost: 21, // net subsidy 14
    fulfillmentCost: 6,
    paymentFee: 5.7,
  });
  const [w, a] = orderLineEconomics(o, products, { refundRestockRate: 0.5 });

  it('allocates shipping subsidy by weight', () => {
    expect(w?.shippingNet).toBeCloseTo(14 * (1 / 7));
    expect(a?.shippingNet).toBeCloseTo(14 * (6 / 7));
  });

  it('allocates fulfillment by units', () => {
    expect(w?.fulfillment).toBeCloseTo(2);
    expect(a?.fulfillment).toBeCloseTo(4);
  });

  it('allocates payment fees by revenue after discounts', () => {
    expect(w?.paymentFees).toBeCloseTo(5.7 * (100 / 190));
    expect(a?.paymentFees).toBeCloseTo(5.7 * (90 / 190));
  });

  it('reconciles allocated costs back to the order totals', () => {
    const rows = [w, a].filter((r) => r !== undefined);
    const sum = (k: 'shippingNet' | 'fulfillment' | 'paymentFees'): number => rows.reduce((s, r) => s + r[k], 0);
    expect(sum('shippingNet')).toBeCloseTo(o.shippingCost - o.shippingCharged);
    expect(sum('fulfillment')).toBeCloseTo(o.fulfillmentCost);
    expect(sum('paymentFees')).toBeCloseTo(o.paymentFee);
  });

  it('computes net revenue and COGS', () => {
    expect(a?.grossRevenue).toBe(100);
    expect(a?.netRevenue).toBe(90);
    expect(a?.cogs).toBe(40);
  });

  it('recovers COGS of refunded units at the restock rate', () => {
    const refunded = order({ lines: [line('W', 2, 100, { refundedQty: 2, refundAmount: 200 })] });
    const [row] = orderLineEconomics(refunded, products, { refundRestockRate: 0.5 });
    expect(row?.netRevenue).toBe(0);
    // 2 units sold, 2 refunded, half restocked -> COGS for 1 unit is lost.
    expect(row?.cogs).toBe(40);
  });

  it('throws on an unknown SKU', () => {
    expect(() => orderLineEconomics(order({ lines: [line('NOPE', 1, 1)] }), products, DEFAULT_ASSUMPTIONS)).toThrow(/Unknown SKU/);
  });
});

describe('contribution', () => {
  it('builds CM1 and CM2', () => {
    const { cm1, cm2 } = contribution({ netRevenue: 100, cogs: 40, shippingNet: 10, fulfillment: 5, paymentFees: 3 });
    expect(cm1).toBe(60);
    expect(cm2).toBe(42);
  });
});

describe('lineEconomicsInRange', () => {
  it('only includes orders inside the inclusive range', () => {
    const ds = makeDataset({
      orders: [
        order({ date: '2026-01-04', lines: [line('W', 1, 100)] }),
        order({ date: '2026-01-05', lines: [line('W', 1, 100)] }),
        order({ date: '2026-01-07', lines: [line('W', 1, 100)] }),
        order({ date: '2026-01-08', lines: [line('W', 1, 100)] }),
      ],
    });
    const rows = lineEconomicsInRange(ds, DEFAULT_ASSUMPTIONS, { from: '2026-01-05', to: '2026-01-07' });
    expect(rows.map((r) => r.date)).toEqual(['2026-01-05', '2026-01-07']);
  });
});

describe('pct and ratio', () => {
  it('never divide by zero', () => {
    expect(pct(5, 0)).toBe(0);
    expect(ratio(5, 0)).toBeNull();
    expect(pct(1, 4)).toBe(25);
    expect(ratio(9, 3)).toBe(3);
  });
});
