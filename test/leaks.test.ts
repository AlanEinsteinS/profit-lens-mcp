import { describe, expect, it } from 'vitest';
import { generateDataset, SCENARIO } from '../src/data/generator.js';
import { DEFAULT_ASSUMPTIONS } from '../src/finance/assumptions.js';
import { addDays, trailingRange } from '../src/finance/dates.js';
import { detectChannelOverspend, findProfitLeaks, severityFor } from '../src/finance/leaks.js';
import { line, makeDataset, order, spend } from './fixtures.js';

describe('severityFor', () => {
  it('maps monthly impact to severity bands', () => {
    expect(severityFor(5000)).toBe('high');
    expect(severityFor(4999)).toBe('medium');
    expect(severityFor(1500)).toBe('medium');
    expect(severityFor(10)).toBe('low');
  });
});

describe('detectChannelOverspend', () => {
  const asOf = '2026-03-01';
  const build = (spendNow: number, ordersNow: number) => {
    const orders = [];
    const adSpend = [];
    for (let i = 0; i < 56; i += 1) {
      const date = addDays(asOf, -i);
      const recent = i < 28;
      adSpend.push(spend(date, 'tiktok', recent ? spendNow : 100));
      const count = recent ? ordersNow : 4;
      for (let k = 0; k < count; k += 1) orders.push(order({ date, channel: 'tiktok', lines: [line('W', 1, 100)] }));
    }
    return makeDataset({ meta: { storeName: 'T', currency: 'USD', seed: 0, startDate: '2025-12-01', asOf }, orders, adSpend });
  };

  it('flags spend growth whose marginal ROAS is below breakeven', () => {
    // Spend 100 -> 300/day while orders go 4 -> 5/day: +$100 revenue for +$200 spend = 0.5x marginal ROAS.
    const [leak] = detectChannelOverspend(build(300, 5), DEFAULT_ASSUMPTIONS, trailingRange(asOf, 30));
    expect(leak?.type).toBe('channel_overspend');
    expect(leak?.subject).toBe('tiktok');
    expect(leak?.evidence.marginalRoas).toBeCloseTo(0.5);
    // Extra spend 28 x 200 = 5600; extra CM2 = 28 x 60 = 1680; monthly = 3920 x 30/28
    expect(leak?.monthlyImpact).toBeCloseTo((5600 - 1680) * (30 / 28));
  });

  it('does not flag spend growth that pays for itself', () => {
    // Spend 100 -> 300/day while orders go 4 -> 10/day: marginal ROAS 3x, above the ~1.67x breakeven.
    expect(detectChannelOverspend(build(300, 10), DEFAULT_ASSUMPTIONS, trailingRange(asOf, 30))).toEqual([]);
  });

  it('ignores small budget changes', () => {
    expect(detectChannelOverspend(build(110, 4), DEFAULT_ASSUMPTIONS, trailingRange(asOf, 30))).toEqual([]);
  });
});

describe('findProfitLeaks on the demo store', () => {
  const ds = generateDataset();
  const report = findProfitLeaks(ds, DEFAULT_ASSUMPTIONS, trailingRange(ds.meta.asOf, 30));
  const subjects = report.leaks.map((l) => l.subject);

  it('finds every planted problem from the raw numbers', () => {
    expect(subjects).toContain(SCENARIO.heavyLowMarginSku);
    expect(subjects).toContain(SCENARIO.highRefundSku);
    expect(subjects).toContain(SCENARIO.overstockedSku);
    expect(subjects).toContain(SCENARIO.overspendingChannel);
    expect(subjects).toContain(SCENARIO.leakedDiscountCode);
    for (const sku of SCENARIO.stockoutRiskSkus) expect(subjects).toContain(sku);
  });

  it('does not flag healthy SKUs or codes', () => {
    expect(subjects).not.toContain('AA-CNDL-CED');
    expect(subjects).not.toContain('WELCOME10');
    expect(subjects).not.toContain('meta');
  });

  it('ranks by monthly impact and totals correctly', () => {
    const impacts = report.leaks.map((l) => l.monthlyImpact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(report.totalMonthlyImpact).toBeCloseTo(impacts.reduce((a, b) => a + b, 0));
    for (const l of report.leaks) {
      expect(l.monthlyImpact).toBeGreaterThan(0);
      expect(l.explanation.length).toBeGreaterThan(40);
      expect(l.suggestedAction.length).toBeGreaterThan(20);
    }
  });

  it('filters by detector type and minimum impact', () => {
    const only = findProfitLeaks(ds, DEFAULT_ASSUMPTIONS, trailingRange(ds.meta.asOf, 30), { types: ['dead_stock'] });
    expect(only.leaks.map((l) => l.type)).toEqual(['dead_stock']);
    const big = findProfitLeaks(ds, DEFAULT_ASSUMPTIONS, trailingRange(ds.meta.asOf, 30), { minMonthlyImpact: 5000 });
    expect(big.leaks.every((l) => l.severity === 'high')).toBe(true);
  });
});
