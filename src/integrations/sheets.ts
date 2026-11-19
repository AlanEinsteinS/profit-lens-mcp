import { GoogleAuth } from 'google-auth-library';
import { AssumptionsSchema, PartialAssumptionsSchema, type Assumptions, type PartialAssumptions } from '../finance/assumptions.js';

/**
 * Optional Google Sheets integration: reads model assumptions from a
 * two-column range (label | value) in a financial-model spreadsheet, e.g.
 *
 *   | Starting cash      | $420,000 |
 *   | Monthly opex       | 92,000   |
 *   | PO deposit         | 30%      |
 *
 * Labels are matched loosely ("Starting cash", "starting_cash" and
 * "startingCash" all work). Access is read-only via a service account.
 */

export interface SheetsConfig {
  spreadsheetId: string;
  range: string;
  /** Raw service-account JSON. If absent, Application Default Credentials are used. */
  serviceAccountJson?: string | undefined;
}

export interface SheetAssumptions {
  values: PartialAssumptions;
  ignoredLabels: string[];
}

const normalize = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, '');

const KEY_BY_LABEL = new Map<string, keyof Assumptions>(
  (Object.keys(AssumptionsSchema.shape) as (keyof Assumptions)[]).map((key) => [normalize(key), key]),
);

/** Parses "$1,234.50", "30%", "(500)" and plain numbers. Returns null when not numeric. */
export function parseSheetNumber(raw: string): number | null {
  let text = raw.trim();
  if (text === '') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  const isPercent = text.endsWith('%');
  text = text.replace(/[$,%\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text) * sign;
  return isPercent ? value / 100 : value;
}

export function parseAssumptionRows(rows: readonly (readonly unknown[])[]): SheetAssumptions {
  const values: Record<string, number> = {};
  const ignoredLabels: string[] = [];
  for (const row of rows) {
    const [label, rawValue] = row;
    if (typeof label !== 'string' || label.trim() === '') continue;
    const key = KEY_BY_LABEL.get(normalize(label));
    const value =
      typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' ? parseSheetNumber(rawValue) : null;
    if (!key || value === null) {
      ignoredLabels.push(label);
      continue;
    }
    values[key] = value;
  }
  return { values: PartialAssumptionsSchema.parse(values), ignoredLabels };
}

export async function loadAssumptionsFromSheet(config: SheetsConfig): Promise<SheetAssumptions> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    ...(config.serviceAccountJson ? { credentials: JSON.parse(config.serviceAccountJson) as Record<string, string> } : {}),
  });
  const client = await auth.getClient();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}` +
    `/values/${encodeURIComponent(config.range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const response = await client.request<{ values?: unknown[][] }>({ url, timeout: 10_000 });
  return parseAssumptionRows(response.data.values ?? []);
}
