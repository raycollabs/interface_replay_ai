import { PlaywrightSurfaceAdapter } from '../surface/adapter.js';
import type { PolicyContext } from '../policy/allowlist.js';
import { redact } from '../policy/redact.js';
import { DiscoveryModel } from './model.js';
import { observeWithMarks, resolveMark } from './setOfMarks.js';
import { DiscoveryActionSchema } from './actions.js';
import { appendTraceEntry, writeTraceSummary } from './trace.js';

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
}

export type DiscoveryResult =
  | { status: 'success'; outputs: Record<string, string>; summary: string; steps: number }
  | { status: 'failed'; summary: string; steps: number }
  | { status: 'stuck'; reason: string; steps: number };

function stateFingerprint(controls: { role: string; accessibleName: string }[], url: string): string {
  const sorted = controls.map((c) => `${c.role}:${c.accessibleName}`).sort().join('|');
  return `${url}::${sorted}`;
}

/**
 * The observe -> decide -> act loop. Stop conditions: max steps, wall-
 * clock timeout, a model-initiated finish() or request_human(), a policy
 * denial, or the same page fingerprint repeating across consecutive
 * turns despite an action having been taken (nothing is changing --
 * continuing would just burn steps).
 */
export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxSteps = opts.maxSteps ?? 15;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
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
    for (let step = 1; step <= maxSteps; step++) {
      if (Date.now() > deadline) {
        writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'TIMEOUT', steps: step - 1 });
        return { status: 'stuck', reason: 'TIMEOUT', steps: step - 1 };
      }

      const screenshotPath = `${opts.evidenceDir}/step-${String(step).padStart(2, '0')}.png`;
      const { controls } = await observeWithMarks(page, screenshotPath);

      const fingerprint = stateFingerprint(controls, page.url());
      if (fingerprint === lastFingerprint) {
        repeatCount++;
        if (repeatCount >= 2) {
          writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'REPEATED_STATE', steps: step - 1 });
          return { status: 'stuck', reason: 'REPEATED_STATE', steps: step - 1 };
        }
      } else {
        repeatCount = 0;
      }
      lastFingerprint = fingerprint;

      const decision = await model.decide(
        { goal: opts.goal, inputNames: Object.keys(opts.inputs), screenshotPath, controls, stepNumber: step, maxSteps },
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

    writeTraceSummary(opts.evidenceDir, { status: 'stuck', reason: 'MAX_STEPS', steps: maxSteps });
    return { status: 'stuck', reason: 'MAX_STEPS', steps: maxSteps };
  } finally {
    await adapter.close();
  }
}
