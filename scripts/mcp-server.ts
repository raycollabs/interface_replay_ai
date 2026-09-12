#!/usr/bin/env tsx
/**
 * Hosts the capability catalog as a real MCP server over HTTP
 * (StreamableHTTP transport, stateless mode -- one transport per
 * request, no session handshake needed for this use case) plus a tiny
 * browser test UI at GET / that calls tools/list and tools/call the
 * same way any other MCP client would, so you can see the tool catalog
 * and invoke one without a Postman collection.
 *
 * Usage:
 *   npm run mcp -- [--port 4600]
 *
 * Then either open http://localhost:4600 in a browser, or curl it
 * directly (see README.md's MCP section for exact commands) -- both
 * paths hit the identical JSON-RPC endpoint.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Page } from 'playwright';
import { buildMcpServer } from '../src/mcp/server.js';
import { TESTER_HTML } from '../src/mcp/testerHtml.js';

function loadDotEnv(): void {
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (!(trimmed.slice(0, eq).trim() in process.env)) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadDotEnv();

async function bootstrapSession(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
}

function parseArgs(argv: string[]) {
  const args: { port: number } = { port: 4600 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capabilitiesDir = fileURLToPath(new URL('../capabilities', import.meta.url));
  const { server, catalog } = buildMcpServer({ capabilitiesDir, bootstrapSession });

  console.log(`MCP catalog: ${catalog.map((e) => e.toolName).join(', ') || '(empty -- no verified/approved capabilities found)'}`);

  const app = express();
  app.use(express.json());

  // The real MCP endpoint -- genuine JSON-RPC 2.0 tools/list and
  // tools/call, reachable by any MCP client, not just the test UI below.
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // The test UI: a static page whose own JS calls the SAME /mcp endpoint.
  app.get('/', (_req, res) => {
    res.type('html').send(TESTER_HTML);
  });

  app.listen(args.port, () => {
    console.log(`MCP server listening on http://localhost:${args.port}`);
    console.log(`Test UI:  http://localhost:${args.port}/`);
    console.log(`Endpoint: POST http://localhost:${args.port}/mcp`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
