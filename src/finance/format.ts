/**
 * Rounds every number in a JSON-like value to `decimals` places. Calculations
 * run at full precision; rounding happens once, at the tool boundary.
 */
export function roundDeep<T>(value: T, decimals = 2): T {
  const factor = 10 ** decimals;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      const rounded = Math.round(v * factor) / factor;
      return Object.is(rounded, -0) ? 0 : rounded;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}

export function signedPct(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}
