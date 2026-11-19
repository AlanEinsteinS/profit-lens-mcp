import { describe, expect, it } from 'vitest';
import { DEFAULT_AS_OF, generateDataset } from '../src/data/generator.js';
import { Rng } from '../src/data/rng.js';
import { addDays, dayOfWeek, daysBetween, previousRange, rangeLength, trailingRange } from '../src/finance/dates.js';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it('stays in range', () => {
    const r = new Rng(1);
    for (let i = 0; i < 1000; i += 1) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('produces Poisson samples with roughly the right mean', () => {
    const r = new Rng(3);
    const n = 4000;
    const mean = Array.from({ length: n }, () => r.poisson(12)).reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeGreaterThan(11.5);
    expect(mean).toBeLessThan(12.5);
  });
});

describe('dates', () => {
  it('does calendar math in UTC', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(dayOfWeek('2026-11-15')).toBe(0);
    expect(trailingRange('2026-01-31', 7)).toEqual({ from: '2026-01-25', to: '2026-01-31' });
    expect(previousRange({ from: '2026-01-25', to: '2026-01-31' })).toEqual({ from: '2026-01-18', to: '2026-01-24' });
    expect(rangeLength({ from: '2026-01-01', to: '2026-01-01' })).toBe(1);
  });

  it('rejects invalid dates', () => {
    expect(() => addDays('nope', 1)).toThrow(/Invalid date/);
  });
});

describe('generateDataset', () => {
  const ds = generateDataset();

  it('is reproducible for the same seed and different for another seed', () => {
    const again = generateDataset();
    expect(again.orders.length).toBe(ds.orders.length);
    expect(again.orders[500]).toEqual(ds.orders[500]);
    expect(generateDataset({ seed: 7 }).orders.length).not.toBe(ds.orders.length);
  });

  it('covers 180 days ending on the as-of date', () => {
    expect(ds.meta.asOf).toBe(DEFAULT_AS_OF);
    expect(daysBetween(ds.meta.startDate, ds.meta.asOf)).toBe(179);
    for (const o of ds.orders) {
      expect(o.date >= ds.meta.startDate && o.date <= ds.meta.asOf).toBe(true);
    }
  });

  it('keeps every order internally consistent', () => {
    const skus = new Set(ds.products.map((p) => p.sku));
    for (const o of ds.orders) {
      expect(o.lines.length).toBeGreaterThan(0);
      expect(o.shippingCost).toBeGreaterThan(0);
      expect(o.paymentFee).toBeGreaterThan(0);
      for (const l of o.lines) {
        expect(skus.has(l.sku)).toBe(true);
        expect(l.discount).toBeLessThanOrEqual(l.unitPrice * l.qty);
        expect(l.refundAmount).toBeLessThanOrEqual(l.unitPrice * l.qty - l.discount + 0.01);
        expect(l.refundedQty).toBeLessThanOrEqual(l.qty);
      }
    }
  });

  it('has inventory for every product and only future open POs', () => {
    expect(ds.inventory.map((i) => i.sku).sort()).toEqual(ds.products.map((p) => p.sku).sort());
    for (const po of ds.purchaseOrders) expect(po.expectedArrival > ds.meta.asOf).toBe(true);
  });

  it('only records ad spend for paid channels', () => {
    expect(new Set(ds.adSpend.map((a) => a.channel))).toEqual(new Set(['meta', 'google', 'tiktok']));
  });
});
