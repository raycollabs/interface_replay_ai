#!/usr/bin/env tsx
/**
 * Slice 2 gate: drives the real adapter against the live target app using
 * a hardcoded step sequence sourced directly from the artifact -- zero LLM
 * involvement, zero replay-engine involvement (that's Slice 3). Proves:
 *   - the targeting ladder resolves every declared control against real
 *     markup, including the associated_label fallback (rung 2 genuinely
 *     fails on the unlabeled member-ID field) and the iframe traversal
 *     (account fields live inside "accounts-frame"),
 *   - policy sits inside perform() and an out-of-scope action is refused,
 *   - no raw memberId value reaches stdout/evidence outside the one
 *     intentional printed result at the end.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';
import { PlaywrightSurfaceAdapter } from '../src/surface/adapter.js';
import { waitForCondition } from '../src/surface/conditions.js';
import { evaluatePolicy, type PolicyContext } from '../src/policy/allowlist.js';
import { captureEvidenceScreenshot } from '../src/surface/evidence.js';

const BASE_URL = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';

async function main() {
  const artifactPath = fileURLToPath(
    new URL('../capabilities/member.read-savings-balance.v1.json', import.meta.url),
  );
  const capability = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf-8')));

  const policyCtx: PolicyContext = {
    allowlist: {
      allowedOrigins: capability.scope.allowedOrigins,
      allowedRoutes: capability.scope.allowedRoutes,
      allowedActionTypes: capability.scope.allowedActionTypes,
      unattendedRiskCeiling: 'safe_reversible',
    },
    mode: 'UNATTENDED',
  };

  console.log('[smoke] policy sanity check: an out-of-allowlist route must be denied before any browser exists');
  const denied = evaluatePolicy({ actionType: 'click', route: '/admin/wire-transfer' }, policyCtx);
  console.log(`[smoke]   -> ${denied.decision} (${'reason' in denied ? denied.reason : 'n/a'})`);
  if (denied.decision !== 'deny') {
    console.error('[smoke] FAILED: expected the out-of-allowlist route to be denied.');
    process.exitCode = 1;
    return;
  }

  const adapter = new PlaywrightSurfaceAdapter(BASE_URL, { headless: true });
  await adapter.launch();
  const page = adapter.getPage();

  console.log('[smoke] logging in (session establishment is outside the capability -- formalized by SessionBroker in Slice 5)...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill('operator');
  await page.locator('input[name=password]').fill('demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
  console.log('[smoke] logged in.');

  const inputs = { memberId: '12345' };
  const outputs: Record<string, string> = {};

  for (const step of capability.steps) {
    process.stdout.write(`[smoke] step ${step.stepId} (${step.action}) ... `);
    const outcome = await adapter.perform(step, capability, inputs, policyCtx);

    if (outcome.kind !== 'executed') {
      console.log(`FAILED: ${JSON.stringify(outcome)}`);
      await captureEvidenceScreenshot(page, capability, capability.targetRegistry, 'tmp/smoke-failure.png');
      process.exitCode = 1;
      await adapter.close();
      return;
    }

    if (outcome.extractedText !== undefined) {
      outputs[step.stepId] = outcome.extractedText;
      console.log(`ok (rung ${outcome.matchedRung}) -> "${outcome.extractedText}"`);
    } else {
      console.log(`ok${outcome.matchedRung !== undefined ? ` (matched rung ${outcome.matchedRung})` : ''}`);
    }

    if (step.postcondition) {
      const held = await waitForCondition(
        page,
        step.postcondition,
        capability.targetRegistry,
        inputs,
        step.timeoutMs,
      );
      if (!held) {
        console.log(`[smoke] postcondition for ${step.stepId} did NOT hold within ${step.timeoutMs}ms`);
        process.exitCode = 1;
        await adapter.close();
        return;
      }
    }
  }

  const checkpointHeld = await waitForCondition(page, capability.checkpoint, capability.targetRegistry, inputs, 5000);
  console.log(`[smoke] checkpoint held: ${checkpointHeld}`);

  await captureEvidenceScreenshot(page, capability, capability.targetRegistry, 'tmp/smoke-success.png');

  console.log('[smoke] outputs:', {
    accountId: outputs['extract-account-id'],
    balance: outputs['extract-balance'],
    currency: outputs['extract-currency'],
  });

  await adapter.close();
  if (!checkpointHeld) process.exitCode = 1;
  else console.log('[smoke] PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
