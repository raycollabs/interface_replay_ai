#!/usr/bin/env tsx
/**
 * The one thing that cannot be faked, per the brief: a genuine LLM-driven
 * run against the live target app, with no pre-existing artifact to
 * follow.
 *
 * Usage:
 *   npm run discover -- --goal "Look up member 12345 and read their savings balance" \
 *     --input memberId=12345 --sensitive-input memberId \
 *     --evidence-dir evidence/discovery-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { runDiscovery } from '../src/discovery/loop.js';
import type { PolicyContext } from '../src/policy/allowlist.js';
import type { PlaywrightSurfaceAdapter } from '../src/surface/adapter.js';

/** Minimal .env loader -- avoids adding a dependency for two lines. */
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
  const args: {
    goal?: string;
    evidenceDir?: string;
    input: Record<string, string>;
    sensitiveInputs: string[];
    maxSteps?: number;
    timeoutMs?: number;
  } = { input: {}, sensitiveInputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--goal') args.goal = argv[++i];
    else if (arg === '--evidence-dir') args.evidenceDir = argv[++i];
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--sensitive-input') args.sensitiveInputs.push(argv[++i]!);
    else if (arg === '--input') {
      const kv = argv[++i]!;
      const eq = kv.indexOf('=');
      args.input[kv.slice(0, eq)] = kv.slice(eq + 1);
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
  if (!args.goal || !args.evidenceDir) {
    console.error('Usage: discover --goal "<goal>" --evidence-dir <path> [--input k=v ...] [--sensitive-input NAME ...]');
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set (checked process.env and .env).');
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';

  // Deliberately narrow scope for discovery -- the concrete containment
  // boundary discussed in policy.ts's docs: no money-moving route is
  // even declared, so the model exploring freely cannot reach one
  // regardless of what it decides to try.
  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: [baseUrl],
      allowedRoutes: ['/login', '/member-search', '/member/*', '/member/*/accounts', '/member/*/accounts-frame'],
      allowedActionTypes: ['navigate', 'click', 'type', 'extract'],
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  console.log(`mode=DISCOVERY goal="${args.goal}"`);

  const result = await runDiscovery({
    evidenceDir: args.evidenceDir,
    goal: args.goal,
    baseUrl,
    inputs: args.input,
    sensitiveInputNames: args.sensitiveInputs,
    policyCtx,
    apiKey,
    maxSteps: args.maxSteps ?? 15,
    timeoutMs: args.timeoutMs ?? 120_000,
    headless: true,
    bootstrapSession: (adapter: PlaywrightSurfaceAdapter) => loginToTargetApp(adapter.getPage(), baseUrl),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'success') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
