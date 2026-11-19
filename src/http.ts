import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config.js';
import type { ProfitLensContext } from './context.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/** Constant-time comparison of bearer tokens (hashing first equalizes lengths). */
function tokensMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireBearer(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!given || !tokensMatch(given, token)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    next();
  };
}

/**
 * Streamable HTTP transport in stateless mode: every POST /mcp gets a fresh
 * McpServer bound to the shared, read-only context. No session state to lose
 * on restart, and it scales horizontally behind any load balancer.
 */
export function createHttpApp(config: Config, ctx: ProfitLensContext) {
  const app = createMcpExpressApp({
    host: config.http.host,
    ...(config.http.allowedHosts ? { allowedHosts: config.http.allowedHosts } : {}),
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: SERVER_NAME,
      version: SERVER_VERSION,
      dataAsOf: ctx.dataset.meta.asOf,
      assumptionsSource: ctx.assumptionsSource.kind,
      slackWrites: ctx.slack.writesEnabled ? 'enabled' : 'disabled',
    });
  });

  app.post('/mcp', requireBearer(config.http.token), async (req: Request, res: Response) => {
    const server = createServer(ctx);
    // No sessionIdGenerator = stateless mode.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[profit-lens] Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server runs Streamable HTTP in stateless mode.' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

export function startHttpServer(config: Config, ctx: ProfitLensContext): Promise<Server> {
  const app = createHttpApp(config, ctx);
  if (!config.http.token && !['127.0.0.1', 'localhost', '::1'].includes(config.http.host)) {
    console.warn('[profit-lens] Listening on a non-loopback address without MCP_HTTP_TOKEN. Set a token or put an authenticating proxy in front.');
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(config.http.port, config.http.host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      console.error(`[profit-lens] Streamable HTTP listening on http://${config.http.host}:${config.http.port}/mcp`);
      resolve(server);
    });
  });
}
