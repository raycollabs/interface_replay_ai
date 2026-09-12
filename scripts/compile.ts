#!/usr/bin/env tsx
/**
 * Compiles a discovery trace into a versioned capability artifact.
 *
 * This demo compiles the specific member.read-savings-balance goal --
 * a general compiler CLI would take the output schema (name/type/
 * description/columnHeaderHint/semanticPurpose per output) from a file
 * rather than hardcoding it, but the compilation LOGIC itself
 * (src/compiler/index.ts) is fully generic.
 *
 * Usage:
 *   npm run compile -- --trace-dir evidence/discovery-run \
 *     --capability-id member.read-savings-balance --version 2 \
 *     --output capabilities/member.read-savings-balance.v2.json \
 *     --replay-input memberId=12345
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { compileCapability, type DesiredOutput } from '../src/compiler/index.js';
import type { PolicyContext } from '../src/policy/allowlist.js';
import type { PlaywrightSurfaceAdapter } from '../src/surface/adapter.js';

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

function parseArgs(argv: string[]) {
  const args: { traceDir?: string; capabilityId?: string; version?: number; output?: string; replayInput: Record<string, string> } = { replayInput: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trace-dir') args.traceDir = argv[++i];
    else if (a === '--capability-id') args.capabilityId = argv[++i];
    else if (a === '--version') args.version = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--replay-input') {
      const kv = argv[++i]!;
      const eq = kv.indexOf('=');
      args.replayInput[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  return args;
}

async function loginToTargetApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.traceDir || !args.capabilityId || !args.version || !args.output) {
    console.error('Usage: compile --trace-dir <dir> --capability-id <id> --version <n> --output <path> --replay-input k=v');
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';

  const desiredOutputs: DesiredOutput[] = [
    { name: 'balance', type: 'decimal', description: 'Current savings balance', columnHeaderHint: 'Balance', semanticPurpose: 'account balance field' },
    { name: 'currency', type: 'string', description: 'ISO currency code', columnHeaderHint: 'Currency', semanticPurpose: 'account currency field' },
    { name: 'accountId', type: 'string', description: 'Savings account identifier', columnHeaderHint: 'Account ID', semanticPurpose: 'account identifier field' },
  ];

  const scope = {
    allowedOrigins: [baseUrl],
    allowedRoutes: ['/login', '/member-search', '/member/*', '/member/*/accounts', '/member/*/accounts-frame'],
    allowedActionTypes: ['navigate', 'click', 'type', 'extract'] as const,
  };
  const policyCtx: PolicyContext = {
    allowlist: { ...scope, allowedActionTypes: [...scope.allowedActionTypes], unattendedRiskCeiling: 'safe_reversible' },
    mode: 'UNATTENDED',
  };

  console.log(`Compiling ${args.capabilityId}@${args.version} from ${args.traceDir}...`);

  const artifact = await compileCapability({
    traceDir: args.traceDir,
    capabilityId: args.capabilityId,
    version: args.version,
    goal: 'Look up a member by identifier and return their current savings balance.',
    product: { vendor: 'local-legacy-bank-demo', app: 'member-servicing-console', versionRange: '1.x' },
    baseUrl,
    scope: { ...scope, allowedActionTypes: [...scope.allowedActionTypes] },
    inputs: { memberId: { type: 'string', required: true, sensitive: true, pattern: '^[0-9]{5}$', example: '12345' } },
    desiredOutputs,
    entryRoute: '/member-search',
    apiKey,
    policyCtx,
    bootstrapSession: (adapter: PlaywrightSurfaceAdapter) => loginToTargetApp(adapter.getPage(), baseUrl),
    compileInputs: args.replayInput,
    headless: true,
  });

  writeFileSync(args.output, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${args.output} (status: ${artifact.status})`);
  console.log(`targetRegistry: ${Object.keys(artifact.targetRegistry).join(', ')}`);
  console.log(`checkpoint purposes: ${JSON.stringify(artifact.checkpoint)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
