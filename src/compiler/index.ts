import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Page } from 'playwright';
import {
  CapabilityDefinitionSchema,
  validateTargetRegistryIntegrity,
  SEMANTIC_PURPOSES,
  type CapabilityDefinition,
  type CapabilityStep,
  type Condition,
  type InputDef,
  type SemanticPurpose,
  type Target,
  type ValueRef,
} from '../contracts/index.js';
import { PlaywrightSurfaceAdapter } from '../surface/adapter.js';
import { resolveTarget } from '../surface/resolveTarget.js';
import type { PolicyContext } from '../policy/allowlist.js';
import type { TraceEntry } from '../discovery/trace.js';
import { classifyCapability, type ActedControl, type DeclaredOutputPurpose } from './classify.js';
import { findColumnLocation } from './tableLookup.js';
import { canonicalizeRoute } from './canonicalize.js';

export interface DesiredOutputField {
  /** Property name -- the output's own top-level name if this is the
   *  only field on its DesiredOutput (a scalar output), or the property
   *  name within the assembled object otherwise. */
  name: string;
  type: 'string' | 'number' | 'boolean' | 'decimal';
  /** Which <thead><th> text identifies this field's column on the final
   *  page. Mechanical lookup (tableLookup.ts), not model-guessed -- a
   *  real capability's output contract is a declared thing, not inferred
   *  from whatever free text the exploring model happened to write in
   *  its own summary (which varies run to run; verified directly across
   *  two discovery runs of the same goal). */
  columnHeaderHint: string;
  semanticPurpose: SemanticPurpose;
}

/**
 * One declared output. A single field produces a scalar output; more
 * than one field produces ONE object-shaped output composed of them --
 * "account: {balance, currency, accountId}" as a real structure, not
 * three independently-named flat fields related only by convention. The
 * per-field MECHANICS (table lookup, targetRegistry entry, extract step)
 * are identical either way; only the shape of the final `outputs` entry
 * this produces differs.
 */
export interface DesiredOutput {
  name: string;
  description: string;
  fields: DesiredOutputField[];
}

/**
 * File-format validator for `--output-schema <path>` (scripts/discover.ts's
 * `--auto-compile`). This is what keeps auto-compilation honest: the
 * caller declares the typed output contract up front, the same
 * requirement `scripts/compile.ts`'s hardcoded literal already enforces
 * -- auto-compile automates the PIPELINE (discover -> compile in one
 * command), it does not relax the "outputs are a declared contract, not
 * inferred from the model's free text" rule that fixed a real bug in
 * Slice 7.
 */
export const DesiredOutputFileSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string(),
    fields: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'decimal']),
          columnHeaderHint: z.string(),
          semanticPurpose: z.enum(SEMANTIC_PURPOSES),
        }),
      )
      .min(1),
  }),
);

export interface CompileOptions {
  traceDir: string;
  capabilityId: string;
  version: number;
  goal: string;
  product: { vendor: string; app: string; versionRange: string };
  baseUrl: string;
  /**
   * `allowedRoutes` is deliberately absent here -- it's derived, not
   * declared, from the routes actually visited during the compiler's own
   * live replay (see canonicalize.ts). A hand-typed route list can drift
   * from what a capability actually needs (too broad, silently) or
   * doesn't need (too narrow, breaks on first replay); a derived one
   * can't drift from reality because it IS reality, observed.
   */
  scope: { allowedOrigins: string[]; allowedActionTypes: CapabilityDefinition['scope']['allowedActionTypes'] };
  inputs: Record<string, InputDef>;
  desiredOutputs: DesiredOutput[];
  entryRoute: string;
  apiKey: string;
  policyCtx: PolicyContext;
  bootstrapSession: (adapter: PlaywrightSurfaceAdapter) => Promise<void>;
  compileInputs: Record<string, unknown>; // real values used to replay the trace to the final page
  headless?: boolean;
}

function readTrace(traceDir: string): TraceEntry[] {
  const lines = readFileSync(`${traceDir}/trace.jsonl`, 'utf-8').trim().split('\n');
  return lines.map((l) => JSON.parse(l) as TraceEntry);
}

function paramRefOrLiteral(value: string): ValueRef {
  const match = value.match(/^\{\{inputs\.(\w+)\}\}$/);
  return match ? { paramRef: match[1]! } : { literal: value };
}

/**
 * The compiler's core claim: every target it emits was verified to
 * resolve UNIQUELY, live, at compile time -- not asserted, not copied
 * from the trace's mark numbers (marks don't survive a fresh page load).
 * Replays the trace's own action sequence via role_and_name (recovering
 * exactly what discovery did), verifying resolvability at each step
 * through the SAME resolveTarget() the replay engine itself uses.
 */
export async function compileCapability(opts: CompileOptions): Promise<CapabilityDefinition> {
  const trace = readTrace(opts.traceDir);
  const actionEntries = trace.filter((e) => e.toolName === 'type' || e.toolName === 'click');

  const adapter = new PlaywrightSurfaceAdapter(opts.baseUrl, { headless: opts.headless ?? true });
  await adapter.launch();
  const page: Page = adapter.getPage();

  try {
    await opts.bootstrapSession(adapter);
    await adapter.performDiscoveryNavigate(opts.entryRoute, opts.policyCtx);

    // Route canonicalization: every route actually visited during this
    // live replay, reduced to a pattern by replacing any segment that
    // exactly matches a declared input's value with :inputName.
    // /login is a fixed baseline (bootstrapSession visits it outside the
    // capability's own steps, and any capability against this target
    // needs it) rather than derived.
    const visitedRoutes = new Set<string>(['/login']);
    const recordRoute = (url: string) => visitedRoutes.add(canonicalizeRoute(url, opts.compileInputs));
    const recordFrames = () => {
      for (const child of page.mainFrame().childFrames()) {
        if (child.url()) recordRoute(child.url());
      }
    };
    recordRoute(page.url());

    const targetRegistry: Record<string, Target> = {};
    const actedControls: ActedControl[] = [];
    const stepPurposeByTraceStep = new Map<number, SemanticPurpose>(); // filled in after classification, keyed by trace step

    // Pass 1: replay each action, verifying resolvability live, recording
    // what was acted on so classification (pass 2) has real facts to work
    // from -- not the trace's own now-stale mark numbers.
    interface ReplayedAction {
      traceStep: number;
      toolName: string;
      role: string;
      accessibleName: string;
      tag: string;
      framePath: string[];
      matchedRung: number;
      candidates: Target['candidates'];
      value?: string;
    }
    const replayed: ReplayedAction[] = [];

    for (const entry of actionEntries) {
      const input = entry.toolInput as { mark: number; value?: string };
      const control = entry.observation.controls.find((c) => c.mark === input.mark);
      if (!control) throw new Error(`Trace step ${entry.step} references mark ${input.mark} not present in its own observation.`);

      const candidates: Target['candidates'] = [
        {
          strategy: { type: 'role_and_name', role: control.role, name: control.accessibleName, exact: true },
          rationale: 'Directly observed role and accessible name during discovery.',
          confidence: 'high',
        },
      ];
      if (control.role === 'textbox') {
        candidates.push({
          strategy: { type: 'associated_label', label: control.accessibleName },
          rationale: 'Fallback for text inputs whose accessible name came from table-cell adjacency rather than a real label association -- the common case for this legacy target, verified for real on the "member identifier input" field.',
          confidence: 'medium',
        });
      }

      const probeTarget: Target = { semanticPurpose: 'member identifier input', framePath: control.framePath, candidates, recordedRung: 0 };
      const resolution = await resolveTarget(page, probeTarget);
      if (resolution.outcome !== 'resolved') {
        throw new Error(
          `Compile-time verification failed for trace step ${entry.step} (role=${control.role} name="${control.accessibleName}"): ${resolution.outcome}. Refusing to emit an unverified target.`,
        );
      }

      replayed.push({
        traceStep: entry.step,
        toolName: entry.toolName,
        role: control.role,
        accessibleName: control.accessibleName,
        tag: control.tag,
        framePath: control.framePath,
        matchedRung: resolution.matchedRung,
        candidates,
        value: entry.toolName === 'type' ? input.value : undefined,
      });

      if (entry.toolName === 'click') {
        const outcome = await adapter.performDiscoveryClick(resolution.locator, opts.policyCtx);
        if (outcome.kind !== 'executed') throw new Error(`Replay of trace step ${entry.step} failed during compilation: ${JSON.stringify(outcome)}`);
        // A click can trigger a navigation whose effects (including a
        // child iframe's own load) are still settling when the very next
        // await resolves. The compiled artifact's own postconditions
        // (synthesized below) protect REPLAY from this; this protects
        // COMPILATION's own findColumnLocation calls from racing the same
        // way -- caught for real once already (see the postcondition
        // comment further down), not a precaution added speculatively.
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        recordRoute(page.url());
        recordFrames();
      } else {
        const rawValue = input.value ?? '';
        const outcome = await adapter.performDiscoveryType(resolution.locator, rawValue, opts.compileInputs, opts.policyCtx);
        if (outcome.kind !== 'executed') throw new Error(`Replay of trace step ${entry.step} failed during compilation: ${JSON.stringify(outcome)}`);
      }

      actedControls.push({
        step: entry.step,
        toolName: entry.toolName,
        role: control.role,
        accessibleName: control.accessibleName,
        tag: control.tag,
        framePath: control.framePath,
      });
    }

    // Pass 2: mechanically locate each declared output FIELD's column on
    // the now-final page -- no model involved, this is a DOM query. A
    // DesiredOutput with multiple fields still gets one lookup per field;
    // grouping them into one object-shaped output happens later, when
    // assembling `outputs` -- the location mechanics don't change.
    const allFields = opts.desiredOutputs.flatMap((o) => o.fields);
    for (const field of allFields) {
      const location = await findColumnLocation(page, field.columnHeaderHint);
      if ('error' in location) throw new Error(`Output field "${field.name}": ${location.error}`);

      const outputCandidates: Target['candidates'] = [
        {
          strategy: { type: 'structural_semantic', rowHeader: location.rowHeader, columnHeader: location.columnHeader },
          rationale: `Mechanically located by column header "${field.columnHeaderHint}" on the compiled artifact's target page; verified to resolve to exactly one cell.`,
          confidence: 'high',
        },
      ];
      const outputTarget: Target = { semanticPurpose: field.semanticPurpose, framePath: location.framePath, candidates: outputCandidates, recordedRung: 0 };
      const verify = await resolveTarget(page, outputTarget);
      if (verify.outcome !== 'resolved') {
        throw new Error(`Output field "${field.name}" location did not verify uniquely: ${verify.outcome}.`);
      }
      targetRegistry[field.semanticPurpose] = { ...outputTarget, recordedRung: verify.matchedRung };
    }

    // Pass 3: the one LLM call -- classify what discovery acted on, and
    // propose the checkpoint. Fresh context; no discovery conversation
    // history carried over.
    const declaredOutputPurposes: DeclaredOutputPurpose[] = allFields.map((f) => ({ name: f.name, semanticPurpose: f.semanticPurpose }));
    const classification = await classifyCapability(opts.apiKey, actedControls, declaredOutputPurposes, opts.goal);

    for (const cp of classification.controlPurposes) {
      const r = replayed.find((x) => x.traceStep === cp.step);
      if (!r) continue;
      stepPurposeByTraceStep.set(cp.step, cp.semanticPurpose);
      targetRegistry[cp.semanticPurpose] = {
        semanticPurpose: cp.semanticPurpose,
        framePath: r.framePath,
        candidates: r.candidates,
        recordedRung: r.matchedRung,
      };
    }

    // Assemble the artifact. Steps: an explicit navigate first (discovery
    // never needed one -- login already lands on entryRoute -- but a
    // replayed capability shouldn't assume that), then one step per
    // replayed action, then one extract step per declared output.
    const steps: CapabilityStep[] = [
      {
        stepId: 'navigate-entry',
        intent: `Open ${opts.entryRoute}`,
        action: 'navigate',
        value: { literal: opts.entryRoute },
        riskClass: 'read_only',
        onBlock: 'escalate',
        timeoutMs: 8000,
      },
    ];
    for (const r of replayed) {
      const purpose = stepPurposeByTraceStep.get(r.traceStep);
      if (!purpose) throw new Error(`Classification did not cover trace step ${r.traceStep}.`);
      steps.push({
        stepId: `step-${r.traceStep}-${r.toolName}`,
        intent: `${r.toolName === 'type' ? 'Enter value into' : 'Activate'} "${r.accessibleName || purpose}"`,
        action: r.toolName === 'type' ? 'type' : 'click',
        targetPurpose: purpose,
        value: r.toolName === 'type' ? paramRefOrLiteral(r.value ?? '') : undefined,
        riskClass: 'read_only',
        onBlock: 'escalate',
        timeoutMs: 8000,
      });
    }
    for (const field of allFields) {
      steps.push({
        stepId: `extract-${field.name}`,
        intent: `Read ${field.name}`,
        action: 'extract',
        targetPurpose: field.semanticPurpose,
        riskClass: 'read_only',
        onBlock: 'escalate',
        timeoutMs: 5000,
      });
    }

    // Synthesize postconditions: every click step waits for the NEXT
    // step's target to become visible before the engine proceeds. This
    // is what the hand-authored artifact does explicitly and the
    // compiler must not skip -- without it, a click that triggers
    // navigation (or, as found here, an iframe reload) races the very
    // next action. Caught for real: the first compiled artifact had no
    // postconditions at all and failed verification -- extract-balance
    // ran before the accounts-frame iframe had loaded, since nothing
    // told the engine to wait for it. A linear discovery trace makes
    // this heuristic sound: whatever a click was FOR is what the next
    // step needs to see.
    for (let i = 0; i < steps.length - 1; i++) {
      const step = steps[i]!;
      const next = steps[i + 1]!;
      if (step.action === 'click' && next.targetPurpose) {
        step.postcondition = { type: 'controlVisible', semanticPurpose: next.targetPurpose };
      }
    }

    // The classification call can propose a checkpoint purpose that
    // belonged to an EARLIER page in the flow (e.g. a nav link clicked
    // two steps ago) rather than the truly final state -- caught for
    // real: one compile run proposed "accounts navigation" alongside the
    // output fields, and that link no longer exists on the page the flow
    // actually ends on, so the checkpoint could never hold. Classification
    // output is a proposal, not a fact -- verify each proposed purpose is
    // actually visible on the live final page before trusting it in the
    // artifact, the same "verify, don't just assert" rule the targeting
    // ladder already follows. A purpose that fails this check is a
    // classification error, not a target to include and hope about.
    const verifiedCheckpointPurposes: SemanticPurpose[] = [];
    for (const purpose of classification.checkpointPurposes) {
      const target = targetRegistry[purpose];
      if (!target) continue;
      const resolution = await resolveTarget(page, target);
      if (resolution.outcome === 'resolved' && (await resolution.locator.isVisible().catch(() => false))) {
        verifiedCheckpointPurposes.push(purpose);
      }
    }
    if (verifiedCheckpointPurposes.length === 0) {
      throw new Error(
        `Classification proposed checkpoint purposes (${classification.checkpointPurposes.join(', ')}) but none of them verified as visible on the live final page. Refusing to emit an empty or unverified checkpoint.`,
      );
    }

    const checkpoint: Condition = {
      type: 'all',
      conditions: verifiedCheckpointPurposes.map((p) => ({ type: 'controlVisible', semanticPurpose: p })),
    };

    // Provenance fingerprint: hash of the sorted (role, name) pairs
    // observed at the checkpoint -- the drift signal a later replay's
    // fingerprint gets compared against (Slice 8).
    const checkpointRoleNames = [...replayed.map((r) => `${r.role}:${r.accessibleName}`)].sort();
    const appFingerprint = createHash('sha256').update(checkpointRoleNames.join('|')).digest('hex').slice(0, 16);

    // A DesiredOutput with one field produces a scalar output; more than
    // one produces a single object-shaped output composed of them --
    // this is the actual "typed outputs and their shape" requirement,
    // not a flat type tag per field.
    const outputs: CapabilityDefinition['outputs'] = {};
    for (const o of opts.desiredOutputs) {
      if (o.fields.length === 1) {
        const field = o.fields[0]!;
        outputs[o.name] = { shape: { type: field.type }, description: o.description, sourceStepId: `extract-${field.name}` };
      } else {
        outputs[o.name] = {
          shape: { type: 'object', properties: Object.fromEntries(o.fields.map((f) => [f.name, { type: f.type }])) },
          description: o.description,
          sourceStepsByProperty: Object.fromEntries(o.fields.map((f) => [f.name, `extract-${f.name}`])),
        };
      }
    }

    const candidate: CapabilityDefinition = {
      schemaVersion: '1.0.0',
      capabilityId: opts.capabilityId,
      version: opts.version,
      status: 'draft',
      name: opts.capabilityId,
      description: opts.goal,
      product: opts.product,
      executionModes: ['ATTENDED', 'UNATTENDED'],
      scope: { ...opts.scope, allowedRoutes: [...visitedRoutes].sort() },
      inputs: opts.inputs,
      outputs,
      targetRegistry,
      knownOutcomes: [], // a single happy-path discovery run cannot discover these -- see docs/slices.md's Slice 7 entry
      interstitials: [],
      steps,
      checkpoint,
      assistedRepair: { enabled: false, maxSteps: 1, requiresTenantPolicy: true },
      provenance: {
        discoveryRunId: opts.traceDir,
        model: 'claude-sonnet-5',
        recordedAt: new Date().toISOString(),
        adapter: 'playwright-web-adapter@0.1.0',
        appFingerprint,
      },
    };

    const parsed = CapabilityDefinitionSchema.parse(candidate);
    const integrityErrors = validateTargetRegistryIntegrity(parsed);
    if (integrityErrors.length > 0) {
      throw new Error(`Compiled artifact failed registry integrity: ${integrityErrors.join('; ')}`);
    }

    return parsed;
  } finally {
    await adapter.close();
  }
}
