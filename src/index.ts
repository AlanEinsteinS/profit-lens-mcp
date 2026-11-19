#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { startHttpServer } from './http.js';
import { createServer } from './server.js';

// stdout belongs to the MCP protocol in stdio mode: every log line goes to stderr.
async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await buildContext(config);

  if (config.transport === 'http') {
    const httpServer = await startHttpServer(config, ctx);
    const shutdown = (): void => {
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  console.error(
    `[profit-lens] stdio server ready: ${ctx.dataset.orders.length} orders through ${ctx.dataset.meta.asOf}, Slack writes ${ctx.slack.writesEnabled ? 'enabled' : 'disabled'}.`,
  );
}

main().catch((error: unknown) => {
  console.error('[profit-lens] Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
