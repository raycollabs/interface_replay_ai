#!/usr/bin/env tsx
/**
 * Closes the loop on the brief's own framing: "think of it as a
 * capability an AI agent can call." An upstream agent (Claude, here)
 * is given the catalog of verified capabilities as tool definitions and
 * a natural-language user request. It discovers which capability
 * applies and invokes it BY NAME with typed args -- Claude decides
 * WHICH capability and WHAT arguments; deterministic replay (llmCalls=0
 * within it) is what actually executes.
 *
 * Usage:
 *   npm run catalog:demo -- --request "What is member 12345's current savings balance?"
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import { loadCatalog, findByToolName } from '../src/catalog/index.js';
import { replay } from '../src/replay/engine.js';
import type { PolicyContext } from '../src/policy/allowlist.js';

function loadDotEnv(): void {
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

async function loginToTargetApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
}

function parseArgs(argv: string[]) {
  const args: { request?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--request') args.request = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const request = args.request ?? "What is member 12345's current savings balance?";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const capabilitiesDir = fileURLToPath(new URL('../capabilities', import.meta.url));
  const catalog = loadCatalog(capabilitiesDir);
  console.log(`Catalog: ${catalog.map((e) => e.toolName).join(', ') || '(empty)'}`);
  if (catalog.length === 0) {
    console.error('No verified/approved capabilities found -- nothing to expose to the agent.');
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({ apiKey });
  const tools = catalog.map((e) => e.toolDefinition);

  console.log(`\nUser request: "${request}"`);
  const first = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    tools,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: request }],
  });

  const toolUse = first.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    console.log('\nAgent responded without calling a capability:');
    console.log(first.content.find((b) => b.type === 'text')?.type === 'text' ? (first.content.find((b) => b.type === 'text') as Anthropic.TextBlock).text : '(no text)');
    return;
  }

  const entry = findByToolName(catalog, toolUse.name);
  if (!entry) throw new Error(`Agent called unknown tool "${toolUse.name}".`);

  console.log(`\nAgent selected capability: ${entry.capability.capabilityId}@${entry.capability.version}`);
  console.log(`Agent-supplied args: ${JSON.stringify(toolUse.input)}`);

  const baseUrl = entry.capability.scope.allowedOrigins[0]!;
  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: entry.capability.scope.allowedOrigins,
      allowedRoutes: entry.capability.scope.allowedRoutes,
      allowedActionTypes: entry.capability.scope.allowedActionTypes,
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  const evidenceDir = 'evidence/catalog-invocation';
  const result = await replay(
    entry.capability,
    toolUse.input as Record<string, unknown>,
    policyCtx,
    { evidenceDir, mode: 'UNATTENDED', headless: true },
    (page) => loginToTargetApp(page, baseUrl),
  );
  console.log(`\nDeterministic execution result: ${JSON.stringify(result)}`);

  const followUp = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    tools,
    messages: [
      { role: 'user', content: request },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }] },
    ],
  });

  const finalText = followUp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  console.log(`\nAgent's final answer: ${finalText?.text ?? '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
