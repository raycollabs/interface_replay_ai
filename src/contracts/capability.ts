import { z } from 'zod';
import { ConditionSchema } from './condition.js';
import { TargetSchema } from './target.js';

export const RiskClassSchema = z.enum([
  'read_only',
  'safe_reversible',
  'mutating_reversible',
  'risky_irreversible',
]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'type',
  'select',
  'extract',
  'wait',
  'assert',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/**
 * A step's value is either a literal (rare — mostly for `select` options
 * that are part of the flow's identity, e.g. "Savings" sub-account type)
 * or a reference to a declared input parameter. Binding as `paramRef` here,
 * rather than inferring parameterization post-hoc from a recorded literal,
 * is what keeps raw input values (including PII) out of the artifact and
 * out of anything derived from it.
 */
export const ValueRefSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ paramRef: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

export const CapabilityStepSchema = z.object({
  stepId: z.string(),
  /** Human-readable purpose of this step — what a reviewer approving a
   *  money-moving capability reads, not `click(#btn_4)`. */
  intent: z.string(),
  action: ActionTypeSchema,
  target: TargetSchema.optional(), // absent for e.g. `wait`
  value: ValueRefSchema.optional(),
  /** Must hold before acting; unmet -> PRECONDITION_UNMET, never a guess. */
  precondition: ConditionSchema.optional(),
  /** Must hold after acting; replay waits on this rather than sleeping. */
  postcondition: ConditionSchema.optional(),
  riskClass: RiskClassSchema,
  /**
   * What happens when this step cannot proceed (target unresolved,
   * postcondition never met, or a declared interstitial handler exhausts
   * its attempts). Deliberately two values only — assisted LLM repair is
   * NOT a per-step enum option; it is a capability-level, explicitly
   * bounded opt-in (see `assistedRepair` below), so it can never be reached
   * by a step silently defaulting into it.
   */
  onBlock: z.enum(['escalate', 'fail']).default('escalate'),
  timeoutMs: z.number().int().positive().default(5000),
});
export type CapabilityStep = z.infer<typeof CapabilityStepSchema>;

/**
 * A declared, expected result of the flow that is NOT a failure — e.g.
 * "no such member". Evaluated BEFORE postconditions at every step boundary,
 * so a legitimate business answer is never misclassified as a broken step.
 * This ordering is the direct fix for the brief's named "most common
 * design mistake": conflating a business outcome with a crash.
 */
export const KnownOutcomeSchema = z.object({
  code: z.string(),
  description: z.string(),
  detect: ConditionSchema,
  /** If this outcome fires, these become the run's declared outputs
   *  instead of the happy-path outputs (e.g. `{ found: false }`). */
  mapsToOutputs: z.record(z.string()).optional(),
});
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

/**
 * A recoverable runtime condition (a known interstitial dialog, a session
 * re-auth prompt) that replay handles deliberately and boundedly, rather
 * than either blindly proceeding or treating it as a hard failure.
 */
export const InterstitialSchema = z.object({
  match: ConditionSchema,
  handle: z.enum(['dismiss', 'retry', 'reauth', 'escalate']),
  maxAttempts: z.number().int().positive().default(1),
});
export type Interstitial = z.infer<typeof InterstitialSchema>;

export const InputDefSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(true),
  /** Drives redaction-at-capture: the adapter masks this field's screenshot
   *  region and substitutes it below the logging boundary. */
  sensitive: z.boolean().default(false),
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type InputDef = z.infer<typeof InputDefSchema>;

export const OutputDefSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'decimal']),
  description: z.string(),
  sourceStepId: z.string(),
});
export type OutputDef = z.infer<typeof OutputDefSchema>;

/**
 * The capability's minimum required permissions. Effective policy at
 * runtime is `tenantPolicy ∩ capability.scope` — so a balance-read
 * capability cannot reach a wire-transfer route even if the tenant
 * allowlist happens to permit it. Declared here, not inferred from steps,
 * so it is reviewable independent of the step sequence.
 */
export const CapabilityScopeSchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  allowedRoutes: z.array(z.string()).min(1),
  allowedActionTypes: z.array(ActionTypeSchema).min(1),
});

export const CapabilityDefinitionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  capabilityId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'verified', 'approved', 'deprecated', 'disabled']),
  name: z.string(),
  description: z.string(),

  /**
   * The capability belongs to the vendor product, NOT to a tenant.
   * `tenantId` never appears anywhere in this schema — that's the whole
   * multi-tenant reuse mechanism. Tenant-specific values live in a
   * separate TenantBinding (Slice 8) that overrides target strategies and
   * a few config values, keyed by `semanticPurpose`, never by rewriting
   * this object.
   */
  product: z.object({
    vendor: z.string(),
    app: z.string(),
    versionRange: z.string(),
  }),

  /** Unattended execution is a property of the artifact, checked before
   *  a run is allowed to proceed without a human able to intervene. */
  executionModes: z.array(z.enum(['ATTENDED', 'UNATTENDED'])).min(1),

  scope: CapabilityScopeSchema,

  inputs: z.record(InputDefSchema),
  outputs: z.record(OutputDefSchema),

  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  interstitials: z.array(InterstitialSchema).default([]),

  steps: z.array(CapabilityStepSchema).min(1),

  /** The success condition. Required — a capability without a checkpoint
   *  cannot prove it reached the state it claims to have reached. */
  checkpoint: ConditionSchema,

  /**
   * For mutating capabilities only. `stepId` marks the point of no return
   * (e.g. the final "Confirm" submit); `idempotencyProbe`, if present, lets
   * a resumed/retried run detect "this already happened" before acting
   * again, rather than blindly replaying a partially completed
   * irreversible operation.
   */
  commitBoundary: z
    .object({
      stepId: z.string(),
      idempotencyProbe: ConditionSchema.optional(),
    })
    .optional(),

  /**
   * Explicit, bounded, opt-in single-step LLM recovery — kept off the
   * normal replay path on purpose (see CapabilityStep.onBlock comment).
   * Absent/disabled by default; a capability must deliberately declare
   * this to allow it, and it is capped at one step per invocation.
   */
  assistedRepair: z
    .object({
      enabled: z.boolean().default(false),
      maxSteps: z.literal(1).default(1),
      requiresTenantPolicy: z.boolean().default(true),
    })
    .default({ enabled: false, maxSteps: 1, requiresTenantPolicy: true }),

  provenance: z.object({
    discoveryRunId: z.string().optional(),
    model: z.string().optional(),
    recordedAt: z.string().datetime(),
    adapter: z.string(),
    /** Hash of the sorted (role, accessibleName) set observed at the
     *  checkpoint when this version was verified. Compared on later
     *  replays as a drift signal (Slice 8). */
    appFingerprint: z.string().optional(),
  }),
});

export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
