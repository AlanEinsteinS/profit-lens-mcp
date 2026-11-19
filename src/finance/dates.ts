/** Calendar-date helpers. Dates are `YYYY-MM-DD` strings handled in UTC to avoid DST drift. */

const DAY_MS = 86_400_000;

export function parseDate(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${date}`);
  return ms;
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(parseDate(date)).getUTCDay();
}

export interface DateRange {
  /** Inclusive start. */
  from: string;
  /** Inclusive end. */
  to: string;
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

export function rangeLength(range: DateRange): number {
  return daysBetween(range.from, range.to) + 1;
}

/** The last `days` days ending on `asOf` (inclusive). */
export function trailingRange(asOf: string, days: number): DateRange {
  return { from: addDays(asOf, -(days - 1)), to: asOf };
}

/** The window of the same length immediately before `range`. */
export function previousRange(range: DateRange): DateRange {
  const length = rangeLength(range);
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}
