import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildTestContext } from '../src/context.js';
import { createHttpApp } from '../src/http.js';
import { createServer } from '../src/server.js';
import { escapeSlack } from '../src/tools.js';

async function connect(ctx = buildTestContext()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const structured = (r: unknown): Record<string, unknown> => (r as CallToolResult).structuredContent ?? {};
const text = (r: unknown): string => {
  const first = (r as CallToolResult).content[0];
  return first?.type === 'text' ? first.text : '';
};

describe('MCP server (in-memory transport)', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });

  it('advertises the tools with read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'find_profit_leaks',
      'forecast_cash_13_weeks',
      'get_channel_pnl',
      'get_inventory_reorder_alerts',
      'get_sku_margins',
      'get_store_overview',
      'post_weekly_digest_to_slack',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(50);
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== 'post_weekly_digest_to_slack');
    }
  });

  it('returns JSON text and matching structured content', async () => {
    const result = await client.callTool({ name: 'get_sku_margins', arguments: { days: 30, limit: 3 } });
    const data = structured(result);
    expect(JSON.parse(text(result))).toEqual(data);
    expect(data.summary).toMatch(/Cast Iron Planter/);
    expect(data.skus).toHaveLength(3);
  });

  it('rounds money to cents at the boundary', async () => {
    const result = await client.callTool({ name: 'get_channel_pnl', arguments: { days: 7 } });
    const total = structured(result).total as Record<string, number>;
    expect(Number.isInteger(Math.round((total.netRevenue ?? 0) * 100))).toBe(true);
    expect(String(total.netRevenue).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('rejects invalid input with a validation error', async () => {
    const result = (await client.callTool({ name: 'get_sku_margins', arguments: { days: 0 } })) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it('returns a helpful tool error for out-of-range dates and unknown SKUs', async () => {
    const dates = (await client.callTool({
      name: 'get_channel_pnl',
      arguments: { from: '2020-01-01', to: '2020-01-31' },
    })) as CallToolResult;
    expect(dates.isError).toBe(true);
    expect(text(dates)).toMatch(/Data covers/);

    const sku = (await client.callTool({ name: 'get_sku_margins', arguments: { sku: 'NOPE' } })) as CallToolResult;
    expect(sku.isError).toBe(true);
    expect(text(sku)).toMatch(/Unknown SKU/);
  });

  it('serves the resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      'profit-lens://assumptions',
      'profit-lens://catalog',
      'profit-lens://schema',
    ]);
    const assumptions = await client.readResource({ uri: 'profit-lens://assumptions' });
    const body = JSON.parse((assumptions.contents[0] as { text: string }).text) as { values: { startingCash: number } };
    expect(body.values.startingCash).toBeGreaterThan(0);
  });

  it('serves the weekly-profit-review prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['weekly-profit-review']);
    const prompt = await client.getPrompt({ name: 'weekly-profit-review', arguments: { audience: 'cfo', focus: 'TikTok' } });
    const content = prompt.messages[0]?.content;
    expect(content?.type === 'text' ? content.text : '').toMatch(/find_profit_leaks[\s\S]*TikTok/);
  });
});

describe('post_weekly_digest_to_slack gating', () => {
  it('only previews when writes are disabled, even with confirm: true', async () => {
    const ctx = buildTestContext({ writesEnabled: false });
    const client = await connect(ctx);
    const result = await client.callTool({ name: 'post_weekly_digest_to_slack', arguments: { confirm: true } });
    expect(structured(result).mode).toBe('dry_run');
    expect(structured(result).preview).toMatch(/Weekly profit digest/);
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it('requires confirm: true when writes are enabled', async () => {
    const ctx = buildTestContext({ writesEnabled: true });
    const client = await connect(ctx);
    const preview = await client.callTool({ name: 'post_weekly_digest_to_slack', arguments: {} });
    expect(structured(preview).mode).toBe('preview');
    expect(ctx.sentMessages).toHaveLength(0);

    const posted = await client.callTool({
      name: 'post_weekly_digest_to_slack',
      arguments: { confirm: true, note: 'Heads up <!channel>' },
    });
    expect(structured(posted).mode).toBe('posted');
    expect(ctx.sentMessages).toHaveLength(1);
    expect(ctx.sentMessages[0]).toContain('&lt;!channel&gt;');
    expect(ctx.sentMessages[0]).not.toContain('<!channel>');
  });

  it('escapes Slack control characters', () => {
    expect(escapeSlack('<@U123> & <https://x|y>')).toBe('&lt;@U123&gt; &amp; &lt;https://x|y&gt;');
  });
});

describe('Streamable HTTP transport', () => {
  let server: Server;
  let baseUrl: string;
  const token = 'test-token-123';

  beforeAll(async () => {
    const config = loadConfig({ MCP_HTTP_TOKEN: token, PORT: '3000' }, ['--transport', 'http']);
    const app = createHttpApp(config, buildTestContext());
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s);
      });
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('exposes an unauthenticated health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'profit-lens', slackWrites: 'disabled' });
  });

  it('rejects MCP requests without the bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('answers GET /mcp with 405 in stateless mode', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(405);
  });

  it('serves tools to an authenticated MCP client', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const result = await client.callTool({ name: 'find_profit_leaks', arguments: { limit: 3 } });
    expect((structured(result).leaks as unknown[]).length).toBe(3);
    await client.close();
  });
});
