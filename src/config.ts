import { z } from 'zod';
import { DEFAULT_AS_OF, DEFAULT_SEED } from './data/generator.js';

const booleanFlag = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/** Every setting comes from the environment. Secrets are never read from files in the repo. */
const EnvSchema = z.object({
  PROFIT_LENS_SEED: z.coerce.number().int().default(DEFAULT_SEED),
  PROFIT_LENS_AS_OF: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'PROFIT_LENS_AS_OF must be YYYY-MM-DD')
    .default(DEFAULT_AS_OF),

  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Optional bearer token required on /mcp when set. */
  MCP_HTTP_TOKEN: optionalString,
  /** Comma-separated Host header allow-list for DNS-rebinding protection. */
  MCP_ALLOWED_HOSTS: optionalString,

  SLACK_WEBHOOK_URL: optionalString,
  PROFIT_LENS_ENABLE_SLACK_WRITES: booleanFlag,

  GOOGLE_SHEETS_ID: optionalString,
  GOOGLE_SHEETS_RANGE: z.string().default('Assumptions!A:B'),
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
});

export interface Config {
  seed: number;
  asOf: string;
  transport: 'stdio' | 'http';
  http: { host: string; port: number; token: string | undefined; allowedHosts: string[] | undefined };
  slack: { webhookUrl: string | undefined; writesEnabled: boolean };
  sheets: { spreadsheetId: string; range: string; serviceAccountJson: string | undefined } | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  const flagIndex = argv.indexOf('--transport');
  const flagValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const transport = z.enum(['stdio', 'http']).parse(flagValue ?? e.MCP_TRANSPORT);

  return {
    seed: e.PROFIT_LENS_SEED,
    asOf: e.PROFIT_LENS_AS_OF,
    transport,
    http: {
      host: e.HOST,
      port: e.PORT,
      token: e.MCP_HTTP_TOKEN,
      allowedHosts: e.MCP_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean),
    },
    slack: { webhookUrl: e.SLACK_WEBHOOK_URL, writesEnabled: e.PROFIT_LENS_ENABLE_SLACK_WRITES },
    sheets: e.GOOGLE_SHEETS_ID
      ? { spreadsheetId: e.GOOGLE_SHEETS_ID, range: e.GOOGLE_SHEETS_RANGE, serviceAccountJson: e.GOOGLE_SERVICE_ACCOUNT_JSON }
      : undefined,
  };
}
