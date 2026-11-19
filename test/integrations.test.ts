import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_ASSUMPTIONS, resolveAssumptions } from '../src/finance/assumptions.js';
import { roundDeep, signedPct, usd } from '../src/finance/format.js';
import { parseAssumptionRows, parseSheetNumber } from '../src/integrations/sheets.js';
import { isValidSlackWebhookUrl, postSlackMessage } from '../src/integrations/slack.js';

const HOOK = 'https://hooks.slack.com/services/T000/B000/secret';

describe('Google Sheets assumptions', () => {
  it('parses currency, percentages and accounting negatives', () => {
    expect(parseSheetNumber('$420,000')).toBe(420000);
    expect(parseSheetNumber('30%')).toBeCloseTo(0.3);
    expect(parseSheetNumber('(500)')).toBe(-500);
    expect(parseSheetNumber(' 12.5 ')).toBe(12.5);
    expect(parseSheetNumber('n/a')).toBeNull();
    expect(parseSheetNumber('')).toBeNull();
  });

  it('matches labels loosely and reports unknown rows', () => {
    const { values, ignoredLabels } = parseAssumptionRows([
      ['Starting cash', '$250,000'],
      ['monthly_opex', 80000],
      ['PO deposit pct', '40%'],
      ['Favourite colour', 'blue'],
      ['', 5],
    ]);
    expect(values).toEqual({ startingCash: 250000, monthlyOpex: 80000, poDepositPct: 0.4 });
    expect(ignoredLabels).toEqual(['Favourite colour']);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseAssumptionRows([['PO deposit pct', '140%']])).toThrow();
  });

  it('merges overrides onto the defaults', () => {
    const a = resolveAssumptions({ startingCash: 1 }, { monthlyOpex: 2, startingCash: undefined });
    expect(a.startingCash).toBe(1);
    expect(a.monthlyOpex).toBe(2);
    expect(a.safetyStockDays).toBe(DEFAULT_ASSUMPTIONS.safetyStockDays);
  });
});

describe('Slack webhook client', () => {
  it('only accepts hooks.slack.com URLs', () => {
    expect(isValidSlackWebhookUrl(HOOK)).toBe(true);
    expect(isValidSlackWebhookUrl('https://evil.example.com/hooks.slack.com/')).toBe(false);
    expect(isValidSlackWebhookUrl('http://hooks.slack.com/services/x')).toBe(false);
  });

  it('posts JSON with the message text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    await postSlackMessage(HOOK, 'hello', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', mrkdwn: true });
  });

  it('reports HTTP errors without leaking the webhook URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('no_service') });
    let message = '';
    try {
      await postSlackMessage(HOOK, 'hello', fetchImpl);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('HTTP 404');
    expect(message).not.toContain('secret');
  });

  it('refuses non-Slack URLs before making any request', async () => {
    const fetchImpl = vi.fn();
    await expect(postSlackMessage('https://example.com', 'x', fetchImpl)).rejects.toThrow(/hooks\.slack\.com/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const c = loadConfig({}, []);
    expect(c.transport).toBe('stdio');
    expect(c.http.host).toBe('127.0.0.1');
    expect(c.slack.writesEnabled).toBe(false);
    expect(c.sheets).toBeUndefined();
  });

  it('reads env vars and the --transport flag', () => {
    const c = loadConfig(
      {
        PORT: '8080',
        MCP_ALLOWED_HOSTS: 'mcp.example.com, localhost',
        PROFIT_LENS_ENABLE_SLACK_WRITES: 'TRUE',
        SLACK_WEBHOOK_URL: HOOK,
        GOOGLE_SHEETS_ID: 'abc',
      },
      ['--transport', 'http'],
    );
    expect(c.transport).toBe('http');
    expect(c.http.port).toBe(8080);
    expect(c.http.allowedHosts).toEqual(['mcp.example.com', 'localhost']);
    expect(c.slack.writesEnabled).toBe(true);
    expect(c.sheets?.range).toBe('Assumptions!A:B');
  });

  it('fails loudly on invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' }, [])).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ PROFIT_LENS_AS_OF: '15/11/2026' }, [])).toThrow(/YYYY-MM-DD/);
  });
});

describe('format helpers', () => {
  it('rounds nested numbers and drops non-finite values', () => {
    expect(roundDeep({ a: 1.23456, b: [2.005, -0.001], c: 'x', d: Infinity, e: null })).toEqual({
      a: 1.23,
      b: [2.01, 0],
      c: 'x',
      d: null,
      e: null,
    });
  });

  it('formats money and signed percentages', () => {
    expect(usd(1234.6)).toBe('$1,235');
    expect(usd(-50)).toBe('-$50');
    expect(signedPct(12.34)).toBe('+12.3%');
    expect(signedPct(-3)).toBe('-3.0%');
  });
});
