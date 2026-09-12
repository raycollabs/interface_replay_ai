#!/usr/bin/env tsx
/**
 * The one thing that cannot be faked, per the brief: a genuine LLM-driven
 * run against the live target app, with no pre-existing artifact to
 * follow.
 *
 * Usage:
 *   npm run discover -- --goal "Look up member {{inputs.memberId}} and read their savings balance" \
 *     --target-url http://localhost:4173 --entry-route /member-search \
 *     --input memberId=12345 --sensitive-input memberId \
 *     --evidence-dir evidence/discovery-run
 *
 * With --auto-compile, a successful run is immediately compiled into a
 * draft artifact too (see the flag's own comment below for exactly what
 * that does and does not automate).
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { runDiscovery } from '../src/discovery/loop.js';
import { compileCapability, DesiredOutputFileSchema } from '../src/compiler/index.js';
import type { PolicyContext } from '../src/policy/allowlist.js';
import type { PlaywrightSurfaceAdapter } from '../src/surface/adapter.js';
import type { InputDef } from '../src/contracts/index.js';

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
    targetUrl?: string;
    entryRoute: string;
    input: Record<string, string>;
    sensitiveInputs: string[];
    maxSteps?: number;
    timeoutMs?: number;
    autoCompile: boolean;
    outputSchema?: string;
    capabilityId?: string;
    version?: number;
    compileOutput?: string;
    vendor: string;
    app: string;
    versionRange: string;
    patterns: Record<string, string>;
  } = {
    input: {},
    sensitiveInputs: [],
    entryRoute: '/member-search',
    autoCompile: false,
    vendor: 'local-legacy-bank-demo',
    app: 'member-servicing-console',
    versionRange: '1.x',
    patterns: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--goal') args.goal = argv[++i];
    else if (arg === '--evidence-dir') args.evidenceDir = argv[++i];
    else if (arg === '--target-url') args.targetUrl = argv[++i];
    else if (arg === '--entry-route') args.entryRoute = argv[++i]!;
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--sensitive-input') args.sensitiveInputs.push(argv[++i]!);
    else if (arg === '--auto-compile') args.autoCompile = true;
    else if (arg === '--output-schema') args.outputSchema = argv[++i];
    else if (arg === '--capability-id') args.capabilityId = argv[++i];
    else if (arg === '--version') args.version = Number(argv[++i]);
    else if (arg === '--compile-output') args.compileOutput = argv[++i];
    else if (arg === '--vendor') args.vendor = argv[++i]!;
    else if (arg === '--app') args.app = argv[++i]!;
    else if (arg === '--version-range') args.versionRange = argv[++i]!;
    else if (arg === '--pattern') {
      const kv = argv[++i]!;
      const eq = kv.indexOf('=');
      args.patterns[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === '--input') {
      const kv = argv[++i]!;
      const eq = kv.indexOf('=');
      args.input[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  return args;
}

/**
 * Authentication only -- does NOT assume or wait for any particular
 * post-login route. Where discovery actually starts observing is a
 * separate, explicit navigation to --entry-route inside runDiscovery()
 * itself (src/discovery/loop.ts), not inferred from wherever this
 * redirect happens to land. That's what makes the entry point a real,
 * independent input rather than a side effect of the login flow.
 */
async function loginToTargetApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.goal || !args.evidenceDir) {
    console.error(
      'Usage: discover --goal "<goal>" --evidence-dir <path> [--target-url <url>] [--entry-route </path>] ' +
        '[--input k=v ...] [--sensitive-input NAME ...] ' +
        '[--auto-compile --output-schema <path> --capability-id <id> --version <n>]',
    );
    process.exitCode = 1;
    return;
  }
  if (args.autoCompile && (!args.outputSchema || !args.capabilityId || !args.version)) {
    console.error('--auto-compile requires --output-schema, --capability-id, and --version.');
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set (checked process.env and .env).');
    process.exitCode = 1;
    return;
  }

  // The target: --target-url is the genuine input; the env var is only a
  // convenience default so the common case doesn't require typing it.
  const baseUrl = args.targetUrl ?? process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';

  // Deliberately narrow scope for discovery -- the concrete containment
  // boundary discussed in policy.ts's docs: no money-moving route is
  // even declared, so the model exploring freely cannot reach one
  // regardless of what it decides to try. args.entryRoute is folded in
  // explicitly so an arbitrary caller-chosen entry point isn't silently
  // blocked by a fixed list that only anticipated this one demo's routes.
  const allowedRoutes = new Set(['/login', '/member-search', '/member/*', '/member/*/accounts', '/member/*/accounts-frame']);
  allowedRoutes.add(args.entryRoute);
  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: [baseUrl],
      allowedRoutes: [...allowedRoutes],
      allowedActionTypes: ['navigate', 'click', 'type', 'extract'],
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  console.log(`mode=DISCOVERY goal="${args.goal}" target=${baseUrl} entryRoute=${args.entryRoute}`);

  const result = await runDiscovery({
    evidenceDir: args.evidenceDir,
    entryRoute: args.entryRoute,
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
  if (result.status !== 'success') {
    process.exitCode = 1;
    return;
  }

  if (!args.autoCompile) return;

  // --auto-compile automates ONE pipeline step: a successful discovery
  // run immediately becomes a DRAFT artifact, closing 3.2's "after a
  // successful run, emit a typed artifact" gap for real, in one command.
  // It does NOT automate verification or promotion -- those stay
  // deliberate, separate steps (npm run replay on a DIFFERENT input,
  // then npm run promote), because "verified" is supposed to mean a
  // human or process confirmed the artifact generalizes, not merely
  // that the compiler didn't crash. Automating that away would defeat
  // the entire point of the DRAFT -> VERIFIED gate from Slice 7.
  console.log('\n--auto-compile: compiling the run just completed into a draft artifact...');

  const outputSchemaRaw = JSON.parse(readFileSync(args.outputSchema!, 'utf-8'));
  const desiredOutputs = DesiredOutputFileSchema.parse(outputSchemaRaw);

  const inputs: Record<string, InputDef> = {};
  for (const [name, value] of Object.entries(args.input)) {
    inputs[name] = {
      type: 'string',
      required: true,
      sensitive: args.sensitiveInputs.includes(name),
      pattern: args.patterns[name],
      // The literal value actually used in THIS discovery run is a true
      // recorded fact, not a fabricated/overfit example -- unlike a
      // pattern (opt-in via --pattern, never guessed), documenting a
      // real value that worked can't overfit the same way.
      example: value,
    };
  }

  const compileOutput = args.compileOutput ?? `capabilities/${args.capabilityId}.v${args.version}.json`;

  const artifact = await compileCapability({
    traceDir: args.evidenceDir,
    capabilityId: args.capabilityId!,
    version: args.version!,
    goal: args.goal,
    product: { vendor: args.vendor, app: args.app, versionRange: args.versionRange },
    baseUrl,
    scope: { allowedOrigins: [baseUrl], allowedActionTypes: ['navigate', 'click', 'type', 'extract'] },
    inputs,
    desiredOutputs,
    entryRoute: args.entryRoute,
    apiKey,
    policyCtx,
    bootstrapSession: (adapter: PlaywrightSurfaceAdapter) => loginToTargetApp(adapter.getPage(), baseUrl),
    compileInputs: args.input,
    headless: true,
  });

  writeFileSync(compileOutput, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${compileOutput} (status: ${artifact.status})`);
  console.log(
    `Next: verify on an input this run never saw (npm run replay -- --capability ${args.capabilityId} --version ${args.version} --input <name>=<different-value> --evidence-dir evidence/verify-...), then npm run promote.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
