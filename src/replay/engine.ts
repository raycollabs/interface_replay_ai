import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type {
  CapabilityDefinition,
  CapabilityStep,
  ExecutionResult,
  FailureCode,
  RunEvent,
  RunEventType,
  RunMode,
  RunState,
} from '../contracts/index.js';
import { PlaywrightSurfaceAdapter, type PerformOutcome } from '../surface/adapter.js';
import { checkCondition, waitForCondition } from '../surface/conditions.js';
import { captureEvidenceScreenshot } from '../surface/evidence.js';
import type { PolicyContext } from '../policy/allowlist.js';
import { redact, sensitiveValuesFor } from '../policy/redact.js';
import { appendEvent, saveResult, saveRunState } from './runStore.js';
import { readIntervention, waitForResolution, writeIntervention, writeSessionHandle } from '../session/broker.js';

/**
 * NOTE FOR REVIEWERS: this module makes zero calls to any LLM client. It
 * doesn't import one, doesn't have a decision function, and the CLI
 * (scripts/replay.ts) prints `llmCalls=0` precisely because there is no
 * code path here that could make it anything else. See
 * tests/replay/no-llm-import.test.ts for the structural assertion.
 */

export interface ReplayOptions {
  evidenceDir: string;
  mode: RunMode;
  headless?: boolean;
  /**
   * When true, hitting a needs_human condition does NOT return
   * immediately -- the run suspends in place (same browser, same page,
   * lease released to NONE) and polls intervention.json for
   * `status: 'resolved'`, exactly what the operator console writes on
   * Resume. This is what makes "same live session" literal: the browser
   * this ReplayRun holds is never closed while waiting, so a second
   * process (the operator console) can attach to the identical session
   * via the wsEndpoint written to session-handle.json.
   * Default false preserves Slices 3/4's one-shot CLI behavior exactly
   * (return needs_human immediately, caller decides what happens next).
   */
  suspendAndWaitForResume?: boolean;
  /** How long to wait for an operator to resolve the intervention before
   *  giving up and failing with ESCALATION_UNAVAILABLE. Default 10 min. */
  resumeTimeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Business-outcome probes are evaluated BEFORE postconditions, at every
 *  step boundary -- this ordering is the entire fix for conflating a
 *  legitimate business result ("no such member") with a broken step. */
async function detectBusinessOutcome(
  page: Page,
  capability: CapabilityDefinition,
  inputs: Record<string, unknown>,
): Promise<{ code: string; message: string; outputs?: Record<string, unknown> } | null> {
  for (const outcome of capability.knownOutcomes) {
    if (await checkCondition(page, outcome.detect, capability.targetRegistry, inputs)) {
      return { code: outcome.code, message: outcome.description, outputs: outcome.mapsToOutputs };
    }
  }
  return null;
}

/**
 * Bounded, declared recovery for a currently-present interstitial. Both
 * 'dismiss' and 'retry' act on the live surface through a SYNTHETIC step
 * routed via adapter.perform() -- the engine's own recovery logic has no
 * shortcut that bypasses the policy check any other action would go
 * through. Returns true if the interstitial condition no longer holds
 * afterward.
 */
async function handleInterstitial(
  page: Page,
  interstitial: CapabilityDefinition['interstitials'][number],
  capability: CapabilityDefinition,
  inputs: Record<string, unknown>,
  adapter: PlaywrightSurfaceAdapter,
  policyCtx: PolicyContext,
): Promise<boolean> {
  if (interstitial.handle === 'escalate') return false; // no auto-recovery attempted by design

  for (let attempt = 0; attempt < interstitial.maxAttempts; attempt++) {
    if (interstitial.handle === 'dismiss') {
      if (!interstitial.dismissTargetPurpose) return false;
      const syntheticStep: CapabilityStep = {
        stepId: '__interstitial_dismiss__',
        intent: 'Dismiss a known interstitial',
        action: 'click',
        targetPurpose: interstitial.dismissTargetPurpose,
        riskClass: 'safe_reversible',
        onBlock: 'fail',
        timeoutMs: 3000,
      };
      const outcome = await adapter.perform(syntheticStep, capability, inputs, policyCtx);
      if (outcome.kind !== 'executed') return false;
    } else if (interstitial.handle === 'retry') {
      const route = new URL(page.url()).pathname;
      const syntheticStep: CapabilityStep = {
        stepId: '__interstitial_retry__',
        intent: 'Retry loading the current route',
        action: 'navigate',
        value: { literal: route },
        riskClass: 'read_only',
        onBlock: 'fail',
        timeoutMs: 8000,
      };
      const outcome = await adapter.perform(syntheticStep, capability, inputs, policyCtx);
      if (outcome.kind !== 'executed') return false;
    } else if (interstitial.handle === 'reauth') {
      // Not implemented until Slice 5 adds a real reauth flow and a
      // credential-refresh path via SessionBroker. Declared now for
      // schema completeness; deliberately a no-op that reports
      // "still present" rather than pretending to succeed.
      return false;
    }
    const stillPresent = await checkCondition(page, interstitial.match, capability.targetRegistry, inputs);
    if (!stillPresent) return true;
  }
  return false;
}

/** Validates runtime inputs against the capability's declared input
 *  schema (required + pattern) BEFORE anything touches the surface.
 *  Returns a human-readable violation, or null if inputs are valid. */
function validateInputs(capability: CapabilityDefinition, inputs: Record<string, unknown>): string | null {
  for (const [name, def] of Object.entries(capability.inputs)) {
    const value = inputs[name];
    if (def.required && (value === undefined || value === null || value === '')) {
      return `Missing required input "${name}".`;
    }
    if (value !== undefined && value !== null && def.pattern) {
      if (!new RegExp(def.pattern).test(String(value))) {
        return `Input "${name}" (value redacted) does not match required pattern ${def.pattern}.`;
      }
    }
  }
  return null;
}

function failureCodeFor(outcomeKind: PerformOutcome['kind']): FailureCode {
  switch (outcomeKind) {
    case 'target_not_resolved':
      return 'TARGET_NOT_RESOLVED';
    case 'target_ambiguous':
      return 'TARGET_AMBIGUOUS';
    case 'frame_not_found':
    case 'no_target_declared':
      return 'ADAPTER_ERROR';
    default:
      return 'ADAPTER_ERROR';
  }
}

export class ReplayRun {
  private state: RunState;
  private readonly redactValues: string[];

  constructor(
    private readonly capability: CapabilityDefinition,
    private readonly inputs: Record<string, unknown>,
    private readonly adapter: PlaywrightSurfaceAdapter,
    private readonly policyCtx: PolicyContext,
    private readonly opts: ReplayOptions,
  ) {
    this.redactValues = sensitiveValuesFor(capability, inputs);
    this.state = {
      runId: randomUUID(),
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.version,
      inputs: redact(inputs, this.redactValues),
      cursor: 0,
      status: 'PENDING',
      mode: opts.mode,
      lease: { owner: 'AUTOMATION', leaseId: null, heldSince: nowIso(), ttlMs: 300000 },
      resolvedFrom: [`${capability.product.vendor}/${capability.capabilityId}@${capability.version}`],
      operatorNotes: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  private persist(): void {
    this.state.updatedAt = nowIso();
    saveRunState(this.opts.evidenceDir, this.state);
  }

  private emit(type: RunEventType, stepId: string | undefined, data: Record<string, unknown>): void {
    const event: RunEvent = {
      eventId: randomUUID(),
      runId: this.state.runId,
      type,
      stepId,
      timestamp: nowIso(),
      data: redact(data, this.redactValues),
    };
    appendEvent(this.opts.evidenceDir, event);
  }

  private async screenshot(label: string): Promise<void> {
    await captureEvidenceScreenshot(
      this.adapter.getPage(),
      this.capability,
      this.capability.targetRegistry,
      `${this.opts.evidenceDir}/${label}.png`,
    ).catch(() => {});
  }

  private async finish(result: ExecutionResult, status: RunState['status']): Promise<ExecutionResult> {
    this.state.status = status;
    this.state.lease = { owner: 'NONE', leaseId: null, heldSince: null, ttlMs: this.state.lease.ttlMs };
    this.persist();
    saveResult(this.opts.evidenceDir, result);
    this.emit('RUN_COMPLETED', undefined, { status: result.status });
    return result;
  }

  /**
   * The single escalation path -- all three "we can't safely proceed"
   * sites in run() below call this instead of duplicating the
   * suspend/notify/wait logic three times. Ownership sequence:
   * AUTOMATION -> NONE (here) -> HUMAN (operator claims) -> NONE
   * (operator resumes) -> AUTOMATION (here, on the resume branch).
   *
   * Returns `{resume: true}` when an operator resolved the intervention
   * (the caller re-grounds and continues from the SAME step); returns
   * `{resume: false, result}` when the caller should return immediately
   * -- either because suspendAndWaitForResume is off (Slices 3/4
   * behavior, unchanged) or because the resume timeout elapsed.
   */
  private async escalate(
    step: CapabilityStep,
    reasonCode: string,
  ): Promise<{ resume: true } | { resume: false; result: ExecutionResult }> {
    const { evidenceDir } = this.opts;
    const interventionId = randomUUID();

    this.emit('INTERVENTION_REQUESTED', step.stepId, { reason: reasonCode, interventionId });
    await this.screenshot('needs-human');

    this.state.status = 'SUSPENDED_AWAITING_HUMAN';
    this.state.lease = { owner: 'NONE', leaseId: null, heldSince: null, ttlMs: this.state.lease.ttlMs };
    this.persist();

    const cdpEndpoint = this.adapter.wsEndpoint;
    if (cdpEndpoint) writeSessionHandle(evidenceDir, { sessionId: this.state.runId, cdpEndpoint });

    writeIntervention(evidenceDir, {
      interventionId,
      runId: this.state.runId,
      sessionId: this.state.runId,
      capabilityId: this.capability.capabilityId,
      goal: this.capability.description,
      stepId: step.stepId,
      reasonCode,
      explanation: `Replay could not safely proceed at step "${step.stepId}" (${step.intent}): ${reasonCode}.`,
      screenshotRef: `${evidenceDir}/needs-human.png`,
      allowedHumanActions: ['view', 'act', 'resume'],
      createdAt: nowIso(),
      status: 'open',
    });

    if (!this.opts.suspendAndWaitForResume) {
      const result: ExecutionResult = {
        status: 'needs_human',
        runId: this.state.runId,
        interventionId,
        reasonCode,
        evidenceRef: evidenceDir,
      };
      saveResult(evidenceDir, result);
      return { resume: false, result };
    }

    this.emit('CONTROL_TRANSFERRED', step.stepId, { to: 'HUMAN', interventionId });
    const resolved = await waitForResolution(evidenceDir, this.opts.resumeTimeoutMs ?? 10 * 60_000);

    if (!resolved) {
      const result = await this.finish(
        {
          status: 'failure',
          code: 'ESCALATION_UNAVAILABLE',
          stepId: step.stepId,
          expected: 'a human operator to claim and resolve the intervention',
          observed: 'no resolution within the escalation timeout',
          evidenceRef: evidenceDir,
        },
        'FAILED',
      );
      return { resume: false, result };
    }

    // Human resolved it. Re-grounding happens in run()'s caller, not here
    // -- this method only re-establishes ownership and records what the
    // human did; it never assumes the blocking condition is now cleared.
    const resolvedIntervention = readIntervention(evidenceDir);
    this.emit('CONTROL_TRANSFERRED', step.stepId, { to: 'AUTOMATION', interventionId });
    this.emit('AUTOMATION_RESUMED', step.stepId, { interventionId });
    this.state.status = 'RUNNING';
    this.state.lease = { owner: 'AUTOMATION', leaseId: null, heldSince: nowIso(), ttlMs: this.state.lease.ttlMs };
    if (resolvedIntervention) {
      this.state.operatorNotes.push({
        timestamp: nowIso(),
        operatorId: resolvedIntervention.claimedBy ?? 'unknown-operator',
        note: resolvedIntervention.resolutionNote ?? '(no note provided)',
      });
    }
    this.persist();
    return { resume: true };
  }

  /**
   * Runs once, immediately after a resume. Never assumes the blocking
   * condition is now cleared -- it re-derives position by checking
   * business outcomes and the step's own declared condition against
   * live page state. A resume that didn't actually fix anything surfaces
   * as a failure here rather than looping back into a second escalation:
   * that keeps the control-transfer state machine simple and bounded.
   *
   * Deliberately does NOT re-attempt the step's action. For an
   * interstitial or a postcondition that failed, the human's job during
   * their control window was to clear the blocking condition on the live
   * page directly (dismiss the dialog, wait it out, whatever) -- not to
   * approve automation trying again. For a risky_irreversible
   * require_human case specifically, re-attempting automatically would
   * risk double-submitting the exact class of action this mechanism
   * exists to gate; if it needed doing, the human did it themselves.
   */
  private async regroundAfterResume(
    page: Page,
    step: CapabilityStep,
  ): Promise<{ ok: true } | { ok: false; result: ExecutionResult }> {
    const { evidenceDir } = this.opts;

    const bo = await detectBusinessOutcome(page, this.capability, this.inputs);
    if (bo) {
      await this.screenshot('business-outcome');
      const result = await this.finish(
        { status: 'business_outcome', code: bo.code, stepId: step.stepId, message: bo.message, outputs: bo.outputs, evidenceRef: evidenceDir },
        'BUSINESS_OUTCOME',
      );
      return { ok: false, result };
    }

    const condition = step.postcondition ?? step.precondition;
    if (condition) {
      // Bounded wait, not a single instant check -- the same reason every
      // OTHER postcondition in this engine is awaited rather than checked
      // once. An operator's action can itself trigger a redirect chain or
      // an iframe reload that is still settling in the instant the resume
      // signal arrives; re-deriving position deserves the same patience
      // as the original action did.
      const held = await waitForCondition(page, condition, this.capability.targetRegistry, this.inputs, 5000);
      if (!held) {
        await this.screenshot('failure');
        const result = await this.finish(
          {
            status: 'failure',
            code: 'POSTCONDITION_UNMET',
            stepId: step.stepId,
            expected: "declared condition to hold after the operator's resolution",
            observed: 're-derived state after resume still does not satisfy it',
            evidenceRef: evidenceDir,
          },
          'FAILED',
        );
        return { ok: false, result };
      }
      this.emit('POSTCONDITION_PASSED', step.stepId, { afterResume: true });
    }

    return { ok: true };
  }

  async run(): Promise<ExecutionResult> {
    this.state.status = 'RUNNING';
    this.persist();
    this.emit('RUN_STARTED', undefined, { capabilityId: this.capability.capabilityId, mode: this.opts.mode });

    const { evidenceDir } = this.opts;

    const inputError = validateInputs(this.capability, this.inputs);
    if (inputError) {
      this.emit('RUN_FAILED', undefined, { code: 'INPUT_CONTRACT_VIOLATION', reason: inputError });
      return this.finish(
        {
          status: 'failure',
          code: 'INPUT_CONTRACT_VIOLATION',
          expected: 'runtime inputs matching the capability\'s declared input schema',
          observed: inputError,
          evidenceRef: evidenceDir,
        },
        'FAILED',
      );
    }

    const page = this.adapter.getPage();
    const outputs: Record<string, unknown> = {};

    stepLoop: for (; this.state.cursor < this.capability.steps.length; this.state.cursor++) {
      const step = this.capability.steps[this.state.cursor]!;
      this.persist();

      if (step.precondition) {
        const held = await checkCondition(page, step.precondition, this.capability.targetRegistry, this.inputs);
        if (!held) {
          const bo = await detectBusinessOutcome(page, this.capability, this.inputs);
          if (bo) {
            this.emit('BUSINESS_OUTCOME_DETECTED', step.stepId, { code: bo.code });
            await this.screenshot('business-outcome');
            return this.finish(
              {
                status: 'business_outcome',
                code: bo.code,
                stepId: step.stepId,
                message: bo.message,
                outputs: bo.outputs,
                evidenceRef: evidenceDir,
              },
              'BUSINESS_OUTCOME',
            );
          }
          await this.screenshot('failure');
          return this.finish(
            {
              status: 'failure',
              code: 'PRECONDITION_UNMET',
              stepId: step.stepId,
              expected: 'precondition to hold before acting',
              observed: 'precondition did not hold',
              evidenceRef: evidenceDir,
            },
            'FAILED',
          );
        }
      }

      this.emit('ACTION_STARTED', step.stepId, { action: step.action });
      const outcome = await this.adapter.perform(step, this.capability, this.inputs, this.policyCtx);

      if (outcome.kind === 'policy_denied') {
        this.emit('POLICY_DENIED', step.stepId, { reason: outcome.reason });
        await this.screenshot('failure');
        return this.finish(
          { status: 'failure', code: 'POLICY_DENIED', stepId: step.stepId, expected: outcome.reason, evidenceRef: evidenceDir },
          'FAILED',
        );
      }

      if (outcome.kind === 'require_human') {
        const escalation = await this.escalate(step, outcome.reason);
        if (!escalation.resume) return escalation.result;
        const grounded = await this.regroundAfterResume(page, step);
        if (!grounded.ok) return grounded.result;
        continue stepLoop;
      }

      const extractedText = outcome.kind === 'executed' ? outcome.extractedText : undefined;
      this.emit('ACTION_COMPLETED', step.stepId, {
        matchedRung: outcome.kind === 'executed' ? outcome.matchedRung : undefined,
        extractedLength: extractedText?.length,
      });

      if (extractedText !== undefined) {
        outputs[step.stepId] = extractedText;
      }

      // Business-outcome probes BEFORE postcondition, at every step boundary.
      let bo = await detectBusinessOutcome(page, this.capability, this.inputs);
      if (bo) {
        this.emit('BUSINESS_OUTCOME_DETECTED', step.stepId, { code: bo.code });
        await this.screenshot('business-outcome');
        return this.finish(
          {
            status: 'business_outcome',
            code: bo.code,
            stepId: step.stepId,
            message: bo.message,
            outputs: bo.outputs,
            evidenceRef: evidenceDir,
          },
          'BUSINESS_OUTCOME',
        );
      }

      // A currently-present declared interstitial gets bounded recovery
      // before we decide anything else failed.
      for (const interstitial of this.capability.interstitials) {
        const present = await checkCondition(page, interstitial.match, this.capability.targetRegistry, this.inputs);
        if (!present) continue;
        this.emit('RECOVERY_ATTEMPTED', step.stepId, { handle: interstitial.handle });
        const recovered = await handleInterstitial(page, interstitial, this.capability, this.inputs, this.adapter, this.policyCtx);
        if (!recovered) {
          if (step.onBlock === 'escalate') {
            const escalation = await this.escalate(step, 'INTERSTITIAL_UNHANDLED');
            if (!escalation.resume) return escalation.result;
            const grounded = await this.regroundAfterResume(page, step);
            if (!grounded.ok) return grounded.result;
            continue stepLoop;
          }
          await this.screenshot('failure');
          return this.finish(
            { status: 'failure', code: 'ADAPTER_ERROR', stepId: step.stepId, observed: 'interstitial not recovered', evidenceRef: evidenceDir },
            'FAILED',
          );
        }
        bo = await detectBusinessOutcome(page, this.capability, this.inputs);
        if (bo) {
          await this.screenshot('business-outcome');
          return this.finish(
            { status: 'business_outcome', code: bo.code, stepId: step.stepId, message: bo.message, outputs: bo.outputs, evidenceRef: evidenceDir },
            'BUSINESS_OUTCOME',
          );
        }
      }

      if (outcome.kind !== 'executed') {
        const code = failureCodeFor(outcome.kind);
        if (step.onBlock === 'escalate') {
          const escalation = await this.escalate(step, code);
          if (!escalation.resume) return escalation.result;
          const grounded = await this.regroundAfterResume(page, step);
          if (!grounded.ok) return grounded.result;
          continue stepLoop;
        }
        await this.screenshot('failure');
        return this.finish(
          { status: 'failure', code, stepId: step.stepId, expected: 'target to resolve', observed: outcome.kind, evidenceRef: evidenceDir },
          'FAILED',
        );
      }

      if (step.postcondition) {
        const held = await waitForCondition(page, step.postcondition, this.capability.targetRegistry, this.inputs, step.timeoutMs);
        if (!held) {
          const bo2 = await detectBusinessOutcome(page, this.capability, this.inputs);
          if (bo2) {
            await this.screenshot('business-outcome');
            return this.finish(
              { status: 'business_outcome', code: bo2.code, stepId: step.stepId, message: bo2.message, outputs: bo2.outputs, evidenceRef: evidenceDir },
              'BUSINESS_OUTCOME',
            );
          }
          if (step.onBlock === 'escalate') {
            const escalation = await this.escalate(step, 'POSTCONDITION_UNMET');
            if (!escalation.resume) return escalation.result;
            const grounded = await this.regroundAfterResume(page, step);
            if (!grounded.ok) return grounded.result;
            continue stepLoop;
          }
          await this.screenshot('failure');
          return this.finish(
            {
              status: 'failure',
              code: 'POSTCONDITION_UNMET',
              stepId: step.stepId,
              expected: 'declared postcondition to hold',
              observed: 'timed out waiting',
              evidenceRef: evidenceDir,
            },
            'FAILED',
          );
        }
        this.emit('POSTCONDITION_PASSED', step.stepId, {});
      }
    }

    const checkpointHeld = await waitForCondition(page, this.capability.checkpoint, this.capability.targetRegistry, this.inputs, 5000);
    if (!checkpointHeld) {
      await this.screenshot('failure');
      return this.finish(
        { status: 'failure', code: 'CHECKPOINT_FAILED', expected: 'declared checkpoint to hold after all steps', observed: 'checkpoint did not hold', evidenceRef: evidenceDir },
        'FAILED',
      );
    }
    this.emit('CHECKPOINT_PASSED', undefined, {});

    const declaredOutputs: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(this.capability.outputs)) {
      declaredOutputs[name] = outputs[def.sourceStepId];
    }

    await this.screenshot('success');
    return this.finish({ status: 'success', outputs: declaredOutputs, evidenceRef: evidenceDir }, 'SUCCEEDED');
  }
}

/**
 * `bootstrapSession`, if supplied, runs once after the browser launches and
 * before any of the capability's own steps execute. Establishing an
 * authenticated session is deliberately NOT part of the capability or the
 * engine -- a capability operates *within* a session; how that session got
 * authenticated is a SessionBroker/TenantBinding concern (Slice 5/8). This
 * hook is the stand-in until that exists: the CLI supplies the demo
 * target's login flow, the engine stays ignorant of it.
 */
export async function replay(
  capability: CapabilityDefinition,
  inputs: Record<string, unknown>,
  policyCtx: PolicyContext,
  opts: ReplayOptions,
  bootstrapSession?: (page: Page) => Promise<void>,
): Promise<ExecutionResult> {
  const adapter = new PlaywrightSurfaceAdapter(capability.scope.allowedOrigins[0]!, { headless: opts.headless ?? true });
  await adapter.launch();
  try {
    if (bootstrapSession) await bootstrapSession(adapter.getPage());
    const run = new ReplayRun(capability, inputs, adapter, policyCtx, opts);
    return await run.run();
  } finally {
    await adapter.close();
  }
}
