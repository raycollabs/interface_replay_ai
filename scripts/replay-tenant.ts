#!/usr/bin/env tsx
/**
 * The multi-tenant stretch demo: replays the SAME base capability that
 * was discovered and verified against tenant A's app instance, against
 * tenant B's differently-labeled instance of the same underlying vendor
 * product -- via a TenantBinding, not a re-recording.
 *
 * Usage (with `TENANT_VARIANT=B PORT=4174 npm run target-app` running in
 * another terminal):
 *   npm run replay:tenant -- --capability member.read-savings-balance --version 2 \
 *     --binding tenants/credit-union-b.json --input memberId=12345 \
 *     --evidence-dir evidence/replay-tenant-b
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { CapabilityDefinitionSchema, TenantBindingSchema } from '../src/contracts/index.js';
import { resolveCapability } from '../src/multitenant/resolve.js';
import { replay } from '../src/replay/engine.js';
import type { PolicyContext } from '../src/policy/allowlist.js';

function parseArgs(argv: string[]) {
  const args: { capability?: string; version?: string; binding?: string; evidenceDir?: string; input: Record<string, string> } = { input: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capability') args.capability = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--binding') args.binding = argv[++i];
    else if (a === '--evidence-dir') args.evidenceDir = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.capability || !args.version || !args.binding || !args.evidenceDir) {
    console.error('Usage: replay-tenant --capability <id> --version <n> --binding <path> --input k=v --evidence-dir <path>');
    process.exitCode = 1;
    return;
  }

  const artifactPath = fileURLToPath(new URL(`../capabilities/${args.capability}.v${args.version}.json`, import.meta.url));
  const base = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf-8')));
  const binding = TenantBindingSchema.parse(JSON.parse(readFileSync(args.binding, 'utf-8')));

  if (base.status !== 'verified' && base.status !== 'approved') {
    console.error(`Refusing to bind an unverified capability (status: ${base.status}). Only verified/approved base capabilities are reused across tenants.`);
    process.exitCode = 1;
    return;
  }

  const { capability, resolvedFrom } = resolveCapability(base, binding);

  console.log(`Resolved ${binding.tenantId}/${binding.applicationInstanceId} -> ${resolvedFrom.join(' + ')}`);
  console.log(`Overridden purposes: ${Object.keys(binding.targetOverrides).join(', ')}`);

  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: capability.scope.allowedOrigins,
      allowedRoutes: capability.scope.allowedRoutes,
      allowedActionTypes: capability.scope.allowedActionTypes,
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  console.log(`mode=REPLAY llmCalls=0 (tenant=${binding.tenantId})`);

  const result = await replay(
    capability,
    args.input,
    policyCtx,
    { evidenceDir: args.evidenceDir, mode: 'UNATTENDED', headless: true, resolvedFromExtra: resolvedFrom.slice(1) },
    (page) => loginToTargetApp(page, binding.entryUrl),
  );

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failure') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
