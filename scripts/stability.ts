#!/usr/bin/env tsx
/**
 * Multi-run stability: replays the same capability + input N times and
 * reports a real flakiness signal, not a guess. Since the target app is
 * static (no randomness in the fixtures), a healthy capability should be
 * PERFECTLY stable -- 100% success, and every step resolving via the
 * exact same rung every single time. Anything less is a genuine finding:
 * either the capability's targeting is more fragile than its "high
 * confidence" rationale claims, or the app has more runtime variance
 * than assumed.
 *
 * Usage:
 *   npm run stability -- --capability member.read-savings-balance --version 2 \
 *     --input memberId=67890 --runs 5 --evidence-dir evidence/stability-v2
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';
import { replay } from '../src/replay/engine.js';
import { writeTraceSummary } from '../src/discovery/trace.js'; // reuses the same tiny JSON-writer helper
import type { PolicyContext } from '../src/policy/allowlist.js';

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

function parseArgs(argv: string[]) {
  const args: { capability?: string; version?: string; evidenceDir?: string; runs: number; input: Record<string, string> } = {
    runs: 5,
    input: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capability') args.capability = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--evidence-dir') args.evidenceDir = argv[++i];
    else if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--input') {
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

/** Reads one run's events.jsonl and extracts { stepId -> matchedRung }
 *  from its ACTION_COMPLETED events -- the same rung-drift signal
 *  REPORT.md §4 describes, made concrete across N actual runs instead of
 *  compared against a single stored provenance value. */
function extractRungsByStep(evidenceDir: string): Record<string, number> {
  const path = `${evidenceDir}/events.jsonl`;
  if (!existsSync(path)) return {};
  const rungs: Record<string, number> = {};
  for (const line of readFileSync(path, 'utf-8').trim().split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as { type: string; stepId?: string; data?: { matchedRung?: number } };
    if (event.type === 'ACTION_COMPLETED' && event.stepId && typeof event.data?.matchedRung === 'number') {
      rungs[event.stepId] = event.data.matchedRung;
    }
  }
  return rungs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.capability || !args.version || !args.evidenceDir) {
    console.error('Usage: stability --capability <id> --version <n> --input k=v --runs <N> --evidence-dir <path>');
    process.exitCode = 1;
    return;
  }

  const artifactPath = fileURLToPath(new URL(`../capabilities/${args.capability}.v${args.version}.json`, import.meta.url));
  const capability = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf-8')));
  const baseUrl = capability.scope.allowedOrigins[0]!;

  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: capability.scope.allowedOrigins,
      allowedRoutes: capability.scope.allowedRoutes,
      allowedActionTypes: capability.scope.allowedActionTypes,
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  console.log(`Replaying ${args.capability}@${args.version} x${args.runs} with input ${JSON.stringify(args.input)}...`);

  const perRun: Array<{ run: number; status: string; durationMs: number; rungsByStep: Record<string, number> }> = [];

  for (let i = 1; i <= args.runs; i++) {
    const evidenceDir = `${args.evidenceDir}/run-${i}`;
    const start = Date.now();
    const result = await replay(
      capability,
      args.input,
      policyCtx,
      { evidenceDir, mode: 'UNATTENDED', headless: true },
      (page) => loginToTargetApp(page, baseUrl),
    );
    const durationMs = Date.now() - start;
    const rungsByStep = extractRungsByStep(evidenceDir);
    perRun.push({ run: i, status: result.status, durationMs, rungsByStep });
    console.log(`  run ${i}/${args.runs}: ${result.status} (${durationMs}ms)`);
  }

  // Aggregate: success rate, and whether any step ever resolved via more
  // than one rung across the N runs (rung drift -- a real stability
  // concern even on runs that all individually succeeded).
  const successCount = perRun.filter((r) => r.status === 'success').length;
  const successRate = successCount / args.runs;

  const rungsSeenByStep: Record<string, Set<number>> = {};
  for (const run of perRun) {
    for (const [stepId, rung] of Object.entries(run.rungsByStep)) {
      (rungsSeenByStep[stepId] ??= new Set()).add(rung);
    }
  }
  const driftingSteps = Object.entries(rungsSeenByStep)
    .filter(([, rungs]) => rungs.size > 1)
    .map(([stepId, rungs]) => ({ stepId, rungsSeen: [...rungs].sort() }));

  const durations = perRun.map((r) => r.durationMs);
  const avgDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  const stable = successRate === 1 && driftingSteps.length === 0;

  const summary = {
    capabilityId: args.capability,
    version: Number(args.version),
    runs: args.runs,
    successRate,
    avgDurationMs,
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
    driftingSteps,
    stable,
    perRun: perRun.map((r) => ({ run: r.run, status: r.status, durationMs: r.durationMs })),
  };

  writeTraceSummary(args.evidenceDir, summary);

  console.log(`\n=== Stability report ===`);
  console.log(`Success rate: ${(successRate * 100).toFixed(0)}% (${successCount}/${args.runs})`);
  console.log(`Duration: avg ${avgDurationMs}ms, min ${summary.minDurationMs}ms, max ${summary.maxDurationMs}ms`);
  console.log(
    driftingSteps.length === 0
      ? 'Rung drift: none -- every step resolved via the identical strategy on every run.'
      : `Rung drift detected: ${driftingSteps.map((d) => `${d.stepId} (rungs ${d.rungsSeen.join(',')})`).join('; ')}`,
  );
  console.log(`Overall: ${stable ? 'STABLE' : 'NOT STABLE'}`);
  console.log(`Summary written to ${args.evidenceDir}/summary.json`);

  if (!stable) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
