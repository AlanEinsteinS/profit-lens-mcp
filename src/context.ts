import type { Config } from './config.js';
import { generateDataset } from './data/generator.js';
import type { Dataset } from './data/types.js';
import { resolveAssumptions, type Assumptions } from './finance/assumptions.js';
import { loadAssumptionsFromSheet } from './integrations/sheets.js';
import { postSlackMessage } from './integrations/slack.js';

/** Everything a tool handler needs. Built once at startup and shared by every MCP session. */
export interface ProfitLensContext {
  dataset: Dataset;
  assumptions: Assumptions;
  assumptionsSource: { kind: 'defaults' | 'google_sheets'; detail: string };
  slack: {
    writesEnabled: boolean;
    configured: boolean;
    post: (text: string) => Promise<void>;
  };
}

export async function buildContext(config: Config): Promise<ProfitLensContext> {
  const dataset = generateDataset({ seed: config.seed, asOf: config.asOf });

  let assumptions = resolveAssumptions();
  let assumptionsSource: ProfitLensContext['assumptionsSource'] = {
    kind: 'defaults',
    detail: 'Built-in defaults (set GOOGLE_SHEETS_ID to load them from a spreadsheet).',
  };
  if (config.sheets) {
    try {
      const sheet = await loadAssumptionsFromSheet(config.sheets);
      assumptions = resolveAssumptions(sheet.values);
      assumptionsSource = {
        kind: 'google_sheets',
        detail:
          `Loaded ${Object.keys(sheet.values).length} values from range ${config.sheets.range}.` +
          (sheet.ignoredLabels.length > 0 ? ` Ignored unknown rows: ${sheet.ignoredLabels.join(', ')}.` : ''),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[profit-lens] Could not load assumptions from Google Sheets, using defaults: ${reason}`);
      assumptionsSource = { kind: 'defaults', detail: `Google Sheets load failed (${reason}); using built-in defaults.` };
    }
  }

  const webhookUrl = config.slack.webhookUrl;
  return {
    dataset,
    assumptions,
    assumptionsSource,
    slack: {
      writesEnabled: config.slack.writesEnabled && webhookUrl !== undefined,
      configured: webhookUrl !== undefined,
      post: async (text) => {
        if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set');
        await postSlackMessage(webhookUrl, text);
      },
    },
  };
}

/** Context for tests and evals: mock data, default assumptions, a fake Slack sink. */
export function buildTestContext(options: { writesEnabled?: boolean; seed?: number } = {}): ProfitLensContext & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    dataset: generateDataset({ seed: options.seed ?? 42 }),
    assumptions: resolveAssumptions(),
    assumptionsSource: { kind: 'defaults', detail: 'test defaults' },
    slack: {
      writesEnabled: options.writesEnabled ?? false,
      configured: options.writesEnabled ?? false,
      post: (text) => {
        sentMessages.push(text);
        return Promise.resolve();
      },
    },
    sentMessages,
  };
}
