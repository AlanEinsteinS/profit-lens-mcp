import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const AUDIENCE_GUIDANCE = {
  founder: 'The reader is the founder: lead with the three decisions to make this week, keep finance jargon light.',
  cfo: 'The reader is the fractional CFO: be precise, show the math behind each number and flag model assumptions.',
  ops: 'The reader runs operations: lead with inventory and fulfillment actions, with quantities and dates.',
} as const;

export function weeklyReviewPrompt(audience: keyof typeof AUDIENCE_GUIDANCE, focus?: string): string {
  return [
    'Prepare the weekly profit review for this store using the profit-lens tools. Work in this order:',
    '1. `get_store_overview` to anchor dates and the catalog.',
    '2. `get_channel_pnl` with days=7, then days=28, to see the week in context. Note MER, CAC and any channel with negative CM3.',
    '3. `get_sku_margins` (days=30) to find SKUs that lose money after ads.',
    '4. `find_profit_leaks` (days=30) and treat its ranking as the agenda.',
    '5. `get_inventory_reorder_alerts` for stockout risks and POs to place.',
    '6. `forecast_cash_13_weeks`, and if a leak fix changes ad spend, run the scenario too (e.g. adSpendChangePct) and compare.',
    '',
    'Then write a memo with: a 3-line summary; a KPI table (this week vs last week); the top 3 leaks with dollar impact and the specific action;',
    'inventory actions with quantities; the cash outlook (low point, buffer). Quote numbers exactly as the tools return them and say which tool each came from.',
    'Do not invent data. If a number is not available from a tool, say so.',
    '',
    AUDIENCE_GUIDANCE[audience],
    ...(focus ? [`Pay particular attention to: ${focus}.`] : []),
    '',
    'Finally, offer to post the digest with `post_weekly_digest_to_slack`. Show the preview first and only call it with confirm: true after the user explicitly agrees.',
  ].join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'weekly-profit-review',
    {
      title: 'Weekly profit review',
      description: 'Runs the full weekly review: P&L by channel, SKU margins, ranked profit leaks, inventory and the 13-week cash outlook, written up as a memo.',
      argsSchema: {
        audience: z.enum(['founder', 'cfo', 'ops']).optional().describe('Who will read the memo (default: founder).'),
        focus: z.string().max(200).optional().describe('Optional topic to dig into, e.g. "TikTok spend" or "Q4 inventory".'),
      },
    },
    ({ audience, focus }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: weeklyReviewPrompt(audience ?? 'founder', focus) } }],
    }),
  );
}
