#!/usr/bin/env tsx
/**
 * The production execution path's CLI entrypoint: given a saved artifact
 * and input parameters, replay it without an LLM in the decision loop.
 *
 * Usage:
 *   npm run replay -- --capability member.read-savings-balance --version 1 \
 *     --input memberId=12345 --evidence-dir evidence/replay-success
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';
import { replay } from '../src/replay/engine.js';
import type { PolicyContext } from '../src/policy/allowlist.js';

function parseArgs(argv: string[]) {
  const args: {
    capability?: string;
    version?: string;
    input: Record<string, string>;
    evidenceDir?: string;
    mode: 'ATTENDED' | 'UNATTENDED';
    waitForHandoff: boolean;
    resumeTimeoutMs?: number;
  } = {
    input: {},
    mode: 'UNATTENDED',
    waitForHandoff: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--capability') args.capability = argv[++i];
    else if (arg === '--version') args.version = argv[++i];
    else if (arg === '--evidence-dir') args.evidenceDir = argv[++i];
    else if (arg === '--mode') args.mode = argv[++i] as 'ATTENDED' | 'UNATTENDED';
    else if (arg === '--wait-for-handoff') args.waitForHandoff = true;
    else if (arg === '--resume-timeout-ms') args.resumeTimeoutMs = Number(argv[++i]);
    else if (arg === '--input') {
      const kv = argv[++i]!;
      const eq = kv.indexOf('=');
      args.input[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  return args;
}

/**
 * Stand-in for SessionBroker (Slice 5): logs into the demo target app
 * before the capability's own steps run. Not part of the engine -- see
 * the doc comment on replay()'s bootstrapSession parameter.
 */
async function loginToTargetApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.capability || !args.version || !args.evidenceDir) {
    console.error('Usage: replay --capability <id> --version <n> --input key=value [--input key2=value2] --evidence-dir <path> [--mode ATTENDED|UNATTENDED]');
    process.exitCode = 1;
    return;
  }

  const artifactPath = fileURLToPath(
    new URL(`../capabilities/${args.capability}.v${args.version}.json`, import.meta.url),
  );
  const capability = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf-8')));

  if (capability.status === 'disabled' || capability.status === 'deprecated') {
    console.error(`Capability ${capability.capabilityId}@${capability.version} is ${capability.status} and cannot be invoked.`);
    process.exitCode = 1;
    return;
  }
  if (!capability.executionModes.includes(args.mode)) {
    console.error(`Capability ${capability.capabilityId}@${capability.version} is not approved for ${args.mode} execution.`);
    process.exitCode = 1;
    return;
  }

  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: capability.scope.allowedOrigins,
      allowedRoutes: capability.scope.allowedRoutes,
      allowedActionTypes: capability.scope.allowedActionTypes,
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: args.mode,
  };

  const baseUrl = capability.scope.allowedOrigins[0]!;

  console.log(`mode=REPLAY llmCalls=0`); // structurally guaranteed -- see engine.ts's header comment
  console.log(`capability=${capability.capabilityId}@${capability.version} inputs=${JSON.stringify(args.input)}`);

  if (args.waitForHandoff) {
    console.log(`(waiting for human handoff -- start the operator console in another terminal:\n  npm run operator -- --evidence-dir ${args.evidenceDir} --capability ${args.capability} --version ${args.version})`);
  }

  const result = await replay(
    capability,
    args.input,
    policyCtx,
    {
      evidenceDir: args.evidenceDir,
      mode: args.mode,
      headless: true,
      suspendAndWaitForResume: args.waitForHandoff,
      resumeTimeoutMs: args.resumeTimeoutMs,
    },
    (page) => loginToTargetApp(page, baseUrl),
  );

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failure') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
