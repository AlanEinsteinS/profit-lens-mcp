import { describe, expect, it } from 'vitest';
import { generateDataset } from '../src/data/generator.js';
import { DEFAULT_ASSUMPTIONS } from '../src/finance/assumptions.js';
import { computeChannelPnl } from '../src/finance/channels.js';
import { trailingRange } from '../src/finance/dates.js';
import { lineEconomicsInRange } from '../src/finance/economics.js';
import { allocateAdSpend, computeSkuMargins } from '../src/finance/margins.js';
import { line, makeDataset, order, spend } from './fixtures.js';

const JAN = { from: '2026-01-01', to: '2026-01-31' };

describe('allocateAdSpend', () => {
  it('splits each channel by that channel\'s revenue per SKU', () => {
    const ds = makeDataset({
      orders: [
        order({ channel: 'meta', lines: [line('W', 3, 100)] }), // meta: W 300
        order({ channel: 'meta', lines: [line('A', 2, 50)] }), // meta: A 100
        order({ channel: 'google', lines: [line('A', 1, 50)] }), // google: A 50
        order({ channel: 'email', lines: [line('W', 1, 100)] }), // unpaid
      ],
    });
    const rows = lineEconomicsInRange(ds, DEFAULT_ASSUMPTIONS, JAN);
    const { bySku, unallocated } = allocateAdSpend(
      rows,
      new Map([
        ['meta', 400],
        ['google', 80],
        ['tiktok', 25],
      ]),
    );
    expect(bySku.get('W')).toBeCloseTo(300);
    expect(bySku.get('A')).toBeCloseTo(100 + 80);
    expect(unallocated).toBe(25); // tiktok drove no revenue
  });
});

describe('computeSkuMargins', () => {
  const ds = makeDataset({
    orders: [
      order({
        channel: 'meta',
        lines: [line('W', 2, 100)],
        shippingCharged: 0,
        shippingCost: 12,
        fulfillmentCost: 4,
        paymentFee: 6,
      }),
    ],
    adSpend: [spend('2026-01-10', 'meta', 50)],
  });
  const report = computeSkuMargins(ds, DEFAULT_ASSUMPTIONS, JAN);
  const w = report.skus.find((s) => s.sku === 'W');

  it('computes the CM1 -> CM2 -> CM3 waterfall', () => {
    expect(w?.netRevenue).toBe(200);
    expect(w?.cm1).toBe(200 - 80);
    expect(w?.cm2).toBe(120 - 12 - 4 - 6);
    expect(w?.adSpend).toBe(50);
    expect(w?.cm3).toBe(48);
    expect(w?.cm3Pct).toBeCloseTo(24);
    expect(w?.perUnit.cm3).toBeCloseTo(24);
  });

  it('reports zero for SKUs with no sales', () => {
    const a = report.skus.find((s) => s.sku === 'A');
    expect(a?.units).toBe(0);
    expect(a?.cm3).toBe(0);
  });
});

describe('computeChannelPnl', () => {
  const ds = makeDataset({
    orders: [
      order({ channel: 'meta', isNewCustomer: true, lines: [line('W', 1, 100)] }),
      order({ channel: 'meta', isNewCustomer: false, lines: [line('W', 1, 100, { discount: 20 })] }),
      order({ channel: 'organic', lines: [line('A', 1, 50)] }),
    ],
    adSpend: [spend('2026-01-10', 'meta', 60)],
  });
  const report = computeChannelPnl(ds, DEFAULT_ASSUMPTIONS, JAN);
  const meta = report.channels.find((c) => c.channel === 'meta');
  const organic = report.channels.find((c) => c.channel === 'organic');

  it('computes ROAS, breakeven ROAS, CAC and AOV for paid channels', () => {
    expect(meta?.orders).toBe(2);
    expect(meta?.newCustomers).toBe(1);
    expect(meta?.aov).toBe(90);
    expect(meta?.roas).toBeCloseTo(180 / 60);
    // CM2 = 180 revenue - 80 COGS (no other costs in this fixture) = 100 -> breakeven ROAS 1.8
    expect(meta?.breakevenRoas).toBeCloseTo(1.8);
    expect(meta?.cac).toBe(60);
    expect(meta?.cm3).toBe(40);
  });

  it('leaves paid metrics null for unpaid channels', () => {
    expect(organic?.paid).toBe(false);
    expect(organic?.roas).toBeNull();
    expect(organic?.cac).toBeNull();
  });

  it('computes store totals and MER', () => {
    expect(report.total.orders).toBe(3);
    expect(report.total.mer).toBeCloseTo(230 / 60);
    expect(report.total.blendedCac).toBeCloseTo(60 / 2);
  });

  it('compares against the previous period of equal length', () => {
    expect(report.previous.range).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(report.previous.netRevenue).toBe(0);
  });
});

describe('reconciliation on the generated dataset', () => {
  it('SKU margins and channel P&L agree on revenue, CM2 and ad spend', () => {
    const ds = generateDataset();
    const range = trailingRange(ds.meta.asOf, 30);
    const skus = computeSkuMargins(ds, DEFAULT_ASSUMPTIONS, range);
    const channels = computeChannelPnl(ds, DEFAULT_ASSUMPTIONS, range);
    expect(skus.totals.netRevenue).toBeCloseTo(channels.total.netRevenue, 4);
    expect(skus.totals.cm2).toBeCloseTo(channels.total.cm2, 4);
    expect(skus.totals.adSpend + skus.unallocatedAdSpend).toBeCloseTo(channels.total.adSpend, 4);
  });
});
