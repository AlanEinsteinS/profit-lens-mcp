import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProfitLensContext } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'profit-lens';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `profit-lens answers unit-economics questions for a DTC ecommerce store: which products and channels make money after every cost, where profit is leaking, what to reorder, and what cash looks like over the next 13 weeks.
Start with get_store_overview. All read tools are side-effect free. Money is USD. "CM3" means contribution after COGS, shipping, fulfillment, payment fees and ad spend.
post_weekly_digest_to_slack is the only tool with side effects: preview first and only pass confirm: true after the user explicitly agrees.`;

/** Builds a fully wired MCP server. Cheap to call: the HTTP transport creates one per request. */
export function createServer(ctx: ProfitLensContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
