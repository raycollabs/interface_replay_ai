import { randomUUID } from 'node:crypto';
import { PlaywrightSurfaceAdapter } from '../surface/adapter.js';
import type { PolicyContext } from '../policy/allowlist.js';
import { redact } from '../policy/redact.js';
import { DiscoveryModel } from './model.js';
import { observeWithMarks, resolveMark } from './setOfMarks.js';
import { DiscoveryActionSchema } from './actions.js';
import { appendTraceEntry, writeTraceSummary } from './trace.js';
import type { RunEvent } from '../contracts/index.js';
import { appendEvent } from '../replay/runStore.js';
import { readIntervention, waitForResolution, writeIntervention, writeSessionHandle } from '../session/broker.js';

export interface DiscoveryOptions {
  evidenceDir: string;
  goal: string;
  /** The target: which app/URL discovery runs against. A genuine input
   *  to the loop, not an environment default the caller happens to read
   *  -- see scripts/discover.ts's --target-url flag. */
  baseUrl: string;
  /**
   * The entry point: where observation starts, e.g. "/member-search".
   * Navigated to explicitly, here, after bootstrapSession -- NOT
   * inferred from wherever a login flow happens to redirect. Closes a
   * real gap: earlier, the CLI's login helper hardcoded a wait for
   * "/member-search" specifically, which meant the entry point was
   * whatever the login redirect happened to land on, not something a
   * caller could actually choose.
   */
  entryRoute: string;
  inputs: Record<string, unknown>;
  /** Declares which inputs are sensitive -- reused across
   *  redaction and to decide what the model is told exists. */
  sensitiveInputNames: string[];
  policyCtx: PolicyContext;
  apiKey: string;
  maxSteps?: number;
  timeoutMs?: number;
  headless?: boolean;
  bootstrapSession?: (adapter: PlaywrightSurfaceAdapter) => Promise<void>;
  /**
   * 3.6 gap closure: "the agent is stuck during discovery" is one of the
   * three explicit handoff triggers in the brief -- but the original
   * implementation only ever wrote a `stuck` trace summary and closed the
   * browser, exactly like a `failed` run, giving a human nowhere to look
   * or act and no live session left to attach to by the time anyone
   * could react. When true, every stuck point below routes through the
   * SAME intervention/session-handle/waitForResolution mechanism
   * `ReplayRun.escalate()` already uses (src/replay/engine.ts) instead of
   * giving up immediately. Default false preserves the original one-shot
   * CLI behavior exactly (e.g. the --auto-compile pipeline, which has no
   * operator to wait for and should fail fast).
   */
  suspendAndWaitForResume?: boolean;
  /** How long to wait for an operator before giving up. Default 10 min,
   *  same default replay's escalate() uses. */
  resumeTimeoutMs?: number;
}

export type DiscoveryResult =
  | { status: 'success'; outputs: Record<string, string>; summary: string; steps: number }
  | { status: 'failed'; summary: string; steps: number }
  | { status: 'stuck'; reason: string; steps: number };

function stateFingerprint(controls: { role: string; accessibleName: string }[], url: string): string {
  const sorted = controls.map((c) => `${c.role}:${c.accessibleName}`).sort().join('|');
  return `${url}::${sorted}`;
}

function emitDiscoveryEvent(evidenceDir: string, runId: string, type: RunEvent['type'], data: Record<string, unknown>): void {
  const event: RunEvent = { eventId: randomUUID(), runId, type, timestamp: new Date().toISOString(), data };
  appendEvent(evidenceDir, event);
}

/**
 * The discovery-side equivalent of `ReplayRun.escalate()` (src/replay/
 * engine.ts) -- same intervention/session-handle/waitForResolution
 * mechanism, same ownership sequence (AUTOMATION -> NONE -> HUMAN -> NONE
 * -> AUTOMATION), reused verbatim rather than re-implemented, because a
 * human-in-the-loop handoff is the same concept regardless of which side
 * of the compile boundary got stuck. `capabilityId` stays unset on the
 * written intervention (there IS no capability yet -- that's the entire
 * point of discovery); `goal` is set instead, which
 * `InterventionRequestSchema` already declares as a separate optional
 * field for exactly this case.
 *
 * Returns `{resume:true}` if an operator resolved the intervention within
 * the timeout (the caller decides what "resume" means for its own stuck
 * condition -- extend a deadline, reset a repeat counter, or just
 * continue the loop); `{resume:false}` if suspension wasn't requested at
 * all, or the timeout elapsed with no resolution.
 */
async function escalateDiscovery(
  adapter: PlaywrightSurfaceAdapter,
  opts: DiscoveryOptions,
  runId: string,
  reasonCode: string,
  explanation: string,
  screenshotPath: string,
  stepNumber: number,
): Promise<{ resume: boolean }> {
  const interventionId = randomUUID();
  emitDiscoveryEvent(opts.evidenceDir, runId, 'INTERVENTION_REQUESTED', { reason: reasonCode, interventionId });

  const cdpEndpoint = adapter.wsEndpoint;
  if (cdpEndpoint) writeSessionHandle(opts.evidenceDir, { sessionId: runId, cdpEndpoint });

  writeIntervention(opts.evidenceDir, {
    interventionId,
    runId,
    sessionId: runId,
    goal: opts.goal,
    stepId: `discovery-step-${stepNumber}`,
    reasonCode,
    explanation,
    screenshotRef: screenshotPath,
    observationRef: screenshotPath,
    allowedHumanActions: ['view', 'act-by-text', 'resume'],
    createdAt: new Date().toISOString(),
    status: 'open',
  });

  if (!opts.suspendAndWaitForResume) return { resume: false };

  emitDiscoveryEvent(opts.evidenceDir, runId, 'CONTROL_TRANSFERRED', { to: 'HUMAN', interventionId });
  const resolved = await waitForResolution(opts.evidenceDir, opts.resumeTimeoutMs ?? 10 * 60_000);

  if (!resolved) {
    emitDiscoveryEvent(opts.evidenceDir, runId, 'RUN_FAILED', { code: 'ESCALATION_UNAVAILABLE', interventionId });
    return { resume: false };
  }

  const resolvedIntervention = readIntervention(opts.evidenceDir);
  emitDiscoveryEvent(opts.evidenceDir, runId, 'CONTROL_TRANSFERRED', { to: 'AUTOMATION', interventionId });
  emitDiscoveryEvent(opts.evidenceDir, runId, 'AUTOMATION_RESUMED', { interventionId });
  appendTraceEntry(opts.evidenceDir, {
    step: stepNumber,
    timestamp: new Date().toISOString(),
    observation: { screenshotPath, controls: [] },
    modelRationale: `(human intervention, not a model decision) ${resolvedIntervention?.resolutionNote ?? '(no note provided)'}`,
    toolName: 'human_intervention',
    toolInput: {},
    outcome: { kind: 'resumed_by_operator', operatorId: resolvedIntervention?.claimedBy ?? 'unknown-operator' },
  });
  return { resume: true };
}

/**
 * The observe -> decide -> act loop. Stop conditions: max steps, wall-
 * clock timeout, a model-initiated finish() or request_human(), a policy
 * denial, or the same page fingerprint repeating across consecutive
 * turns despite an action having been taken (nothing is changing --
 * continuing would just burn steps).
 */
export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = randomUUID();
  // Both mutable: a successful human handoff extends whichever budget
  // triggered the escalation (a fresh time window, or a fresh step
  // allowance) rather than resuming into an escalation that immediately
  // re-fires on the very next check.
  let effectiveMaxSteps = opts.maxSteps ?? 15;
  let deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const redactValues = opts.sensitiveInputNames.map((n) => String(opts.inputs[n] ?? '')).filter(Boolean);

  // The {{inputs.NAME}} placeholder mechanism only protects a sensitive
  // value from ever reaching the model's context THROUGH type() actions
  // -- it does nothing if the caller embeds the raw value directly in
  // free-text goal prose instead of the placeholder. Caught exactly this
  // way once already (see docs/slices.md's Slice 6 entry): a goal like
  // "Look up member 12345..." leaked the value straight into the
  // model's context and back out through finish()'s own outputs/summary.
  // Refuse to even launch a browser rather than rely on every caller
  // remembering the convention.
  for (const value of redactValues) {
    if (opts.goal.includes(value)) {
      throw new Error(
        `Goal text contains a raw sensitive input value. Use the {{inputs.NAME}} placeholder instead ` +
          `(e.g. "Look up member {{inputs.memberId}}...") -- the model must never see this value directly.`,
      );
    }
  }

  const adapter = new PlaywrightSurfaceAdapter(opts.baseUrl, { headless: opts.headless ?? true });
  await adapter.launch();
  if (opts.bootstrapSession) await opts.bootstrapSession(adapter);

  // The entry point is navigated to explicitly and by name, here -- not
  // assumed from wherever bootstrapSession's own login redirect happens
  // to land. This is the actual "accept ... a target (app/URL/entry
  // point) as input" requirement; the entry route is a real parameter,
  // and this is the one place it's acted on.
  const entryOutcome = await adapter.performDiscoveryNavigate(opts.entryRoute, opts.policyCtx);
  if (entryOutcome.kind !== 'executed') {
    // Deliberately NOT routed through escalateDiscovery: an entry route
    // rejected by policy is a configuration problem (the route isn't
    // allowlisted), not a live-page obstacle a human can clear by acting
    // on the session -- there is nothing on screen yet to click through.
    // Fixing this means changing the allowlist/scope, not intervening on
    // a page.
    const result: DiscoveryResult = { status: 'stuck', reason: `ENTRY_ROUTE_BLOCKED: ${JSON.stringify(entryOutcome)}`, steps: 0 };
    writeTraceSummary(opts.evidenceDir, result);
    await adapter.close();
    return result;
  }

  const model = new DiscoveryModel(opts.apiKey, Object.keys(opts.inputs));
  const page = adapter.getPage();

  let lastFingerprint: string | null = null;
  let repeatCount = 0;
  let priorToolResult: string | undefined;
  let priorToolUseId: string | undefined;

  try {
    for (let step = 1; ; step++) {
      if (step > effectiveMaxSteps) {
        const escalationScreenshot = `${opts.evidenceDir}/escalation-step-${String(step).padStart(2, '0')}.png`;
        await page.screenshot({ path: escalationScreenshot }).catch(() => {});
        const escalation = await escalateDiscovery(
          adapter,
          opts,
          runId,
          'MAX_STEPS',
          `Discovery reached its step budget (${effectiveMaxSteps}) without completing the goal.`,
          escalationScreenshot,
          step,
        );
        if (escalation.resume) {
          effectiveMaxSteps += opts.maxSteps ?? 15; // a fresh budget, not an unbounded one
          continue;
        }
        writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'MAX_STEPS', steps: step - 1 });
        return { status: 'stuck', reason: 'MAX_STEPS', steps: step - 1 };
      }

      if (Date.now() > deadline) {
        const escalationScreenshot = `${opts.evidenceDir}/escalation-step-${String(step).padStart(2, '0')}.png`;
        await page.screenshot({ path: escalationScreenshot }).catch(() => {});
        const escalation = await escalateDiscovery(
          adapter,
          opts,
          runId,
          'TIMEOUT',
          `Discovery exceeded its wall-clock timeout (${opts.timeoutMs ?? 120_000}ms) without completing the goal.`,
          escalationScreenshot,
          step,
        );
        if (escalation.resume) {
          deadline = Date.now() + (opts.timeoutMs ?? 120_000); // a fresh window, not the already-passed one
          continue;
        }
        writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'TIMEOUT', steps: step - 1 });
        return { status: 'stuck', reason: 'TIMEOUT', steps: step - 1 };
      }

      const screenshotPath = `${opts.evidenceDir}/step-${String(step).padStart(2, '0')}.png`;
      const { controls } = await observeWithMarks(page, screenshotPath);

      const fingerprint = stateFingerprint(controls, page.url());
      if (fingerprint === lastFingerprint) {
        repeatCount++;
        if (repeatCount >= 2) {
          const escalation = await escalateDiscovery(
            adapter,
            opts,
            runId,
            'REPEATED_STATE',
            'The same page state repeated across consecutive turns despite an action having been taken -- nothing appears to be changing.',
            screenshotPath,
            step,
          );
          if (escalation.resume) {
            repeatCount = 0; // give the (human-modified) state a fresh chance before re-flagging
            continue;
          }
          writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'REPEATED_STATE', steps: step - 1 });
          return { status: 'stuck', reason: 'REPEATED_STATE', steps: step - 1 };
        }
      } else {
        repeatCount = 0;
      }
      lastFingerprint = fingerprint;

      const decision = await model.decide(
        { goal: opts.goal, inputNames: Object.keys(opts.inputs), screenshotPath, controls, stepNumber: step, maxSteps: effectiveMaxSteps },
        priorToolResult,
        priorToolUseId,
      );

      const parsed = DiscoveryActionSchema.safeParse({ action: decision.toolName, ...(decision.toolInput as Record<string, unknown>) });
      let outcomeForTrace: unknown;
      let toolResultText: string;

      if (!parsed.success) {
        toolResultText = `Invalid action: ${parsed.error.message}. Choose one of the declared tools with valid arguments.`;
        outcomeForTrace = { kind: 'invalid_action', error: parsed.error.message };
      } else {
        const action = parsed.data;

        if (action.action === 'finish') {
          appendTraceEntry(opts.evidenceDir, {
            step,
            timestamp: new Date().toISOString(),
            observation: { screenshotPath, controls },
            modelRationale: decision.shortRationale,
            toolName: decision.toolName,
            toolInput: redact(decision.toolInput as Record<string, unknown>, redactValues),
            outcome: { kind: 'finish', success: action.success },
          });
          const result: DiscoveryResult = action.success
            ? { status: 'success', outputs: action.outputs, summary: action.summary, steps: step }
            : { status: 'failed', summary: action.summary, steps: step };
          // The model's own outputs/summary are free text it composed --
          // it could echo a value it was shown for a legitimate reason
          // (an extracted balance) alongside, in principle, anything it
          // picked up from the goal text. Redact the same way the trace
          // already is, at the boundary, not by trusting the model not to.
          const redacted = redact(result, redactValues);
          writeTraceSummary(opts.evidenceDir, redacted);
          return redacted;
        }

        if (action.action === 'request_human') {
          appendTraceEntry(opts.evidenceDir, {
            step,
            timestamp: new Date().toISOString(),
            observation: { screenshotPath, controls },
            modelRationale: decision.shortRationale,
            toolName: decision.toolName,
            toolInput: decision.toolInput,
            outcome: { kind: 'request_human' },
          });
          const escalation = await escalateDiscovery(
            adapter,
            opts,
            runId,
            'MODEL_REQUESTED_HUMAN',
            `The model explicitly asked for a human: ${action.reason}`,
            screenshotPath,
            step,
          );
          if (escalation.resume) {
            priorToolResult = 'A human operator intervened and resumed automation. Re-observe the current state before deciding your next action.';
            priorToolUseId = decision.toolUseId;
            continue;
          }
          const result: DiscoveryResult = { status: 'stuck', reason: `MODEL_REQUESTED_HUMAN: ${action.reason}`, steps: step };
          const redacted = redact(result, redactValues);
          writeTraceSummary(opts.evidenceDir, redacted);
          return redacted;
        }

        if (action.action === 'navigate') {
          const outcome = await adapter.performDiscoveryNavigate(action.route, opts.policyCtx);
          outcomeForTrace = outcome;
          toolResultText = outcome.kind === 'executed' ? `Navigated to ${action.route}.` : `Blocked: ${JSON.stringify(outcome)}`;
        } else {
          const control = controls.find((c) => c.mark === action.mark);
          if (!control) {
            outcomeForTrace = { kind: 'unknown_mark' };
            toolResultText = `No control with mark #${action.mark} in the current observation. Re-check the inventory.`;
          } else {
            const locator = await resolveMark(page, control);
            if (!locator) {
              outcomeForTrace = { kind: 'frame_not_found' };
              toolResultText = `Could not resolve mark #${action.mark} (its frame is no longer present).`;
            } else if (action.action === 'click') {
              const outcome = await adapter.performDiscoveryClick(locator, opts.policyCtx);
              outcomeForTrace = outcome;
              toolResultText = outcome.kind === 'executed' ? `Clicked #${action.mark}.` : `Blocked: ${JSON.stringify(outcome)}`;
            } else if (action.action === 'type') {
              const outcome = await adapter.performDiscoveryType(locator, action.value, opts.inputs, opts.policyCtx);
              outcomeForTrace = outcome;
              toolResultText = outcome.kind === 'executed' ? `Typed into #${action.mark}.` : `Blocked: ${JSON.stringify(outcome)}`;
            } else {
              const outcome = await adapter.performDiscoveryExtract(locator, opts.policyCtx);
              outcomeForTrace = outcome;
              toolResultText =
                outcome.kind === 'executed' ? `Extracted from #${action.mark}: "${outcome.extractedText}"` : `Blocked: ${JSON.stringify(outcome)}`;
            }
          }
        }

        appendTraceEntry(opts.evidenceDir, {
          step,
          timestamp: new Date().toISOString(),
          observation: { screenshotPath, controls },
          modelRationale: decision.shortRationale,
          toolName: decision.toolName,
          toolInput: redact(decision.toolInput as Record<string, unknown>, redactValues),
          outcome: outcomeForTrace,
        });

        if (outcomeForTrace && typeof outcomeForTrace === 'object' && 'kind' in outcomeForTrace) {
          const kind = (outcomeForTrace as { kind: string }).kind;
          // require_human routes to a person (same reasoning as
          // MODEL_REQUESTED_HUMAN above: a risk-class gate is exactly
          // what 3.6 means by "a risky/irreversible step needs a person
          // to decide"). policy_denied does NOT -- an out-of-allowlist
          // action is a containment boundary, the same class of problem
          // as ENTRY_ROUTE_BLOCKED above, and handing a human the live
          // session to work around it would undermine the boundary
          // rather than honor it. (Discovery's own adapter methods never
          // pass a riskClass today -- see performDiscoveryClick/Navigate/
          // Type/Extract in src/surface/adapter.ts -- so require_human
          // cannot actually fire yet here; this branch is future-proofed
          // for when it can, not exercised live by anything currently in
          // this repo.)
          if (kind === 'require_human') {
            const escalation = await escalateDiscovery(
              adapter,
              opts,
              runId,
              'REQUIRE_HUMAN',
              `Policy requires an explicit human decision for this action: ${JSON.stringify(outcomeForTrace)}`,
              screenshotPath,
              step,
            );
            if (escalation.resume) {
              priorToolResult = 'A human operator intervened and resumed automation. Re-observe the current state before deciding your next action.';
              priorToolUseId = decision.toolUseId;
              continue;
            }
          }
          if (kind === 'policy_denied' || kind === 'require_human') {
            const result: DiscoveryResult = { status: 'stuck', reason: `POLICY: ${JSON.stringify(outcomeForTrace)}`, steps: step };
            writeTraceSummary(opts.evidenceDir, result);
            return result;
          }
        }
      }

      priorToolResult = toolResultText;
      priorToolUseId = decision.toolUseId;
    }
    // Unreachable: the loop is unbounded (`for (let step = 1; ; step++)`)
    // specifically so MAX_STEPS can be re-checked (and, on a resumed
    // escalation, extended) in-body rather than via the for-loop's own
    // bound -- every exit path is one of the explicit returns above.
  } finally {
    await adapter.close();
  }
}
