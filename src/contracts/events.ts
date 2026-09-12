import { z } from 'zod';

/**
 * Structured evidence log event types. Deliberately does NOT include a
 * "model chain-of-thought" event — only short operational decision
 * summaries are persisted (see MODEL_DECISION), per the redacted-evidence
 * requirement in a regulated environment.
 */
export const RunEventTypeSchema = z.enum([
  'RUN_STARTED',
  'OBSERVATION_CAPTURED',
  'MODEL_DECISION',
  'POLICY_ALLOWED',
  'POLICY_DENIED',
  'TARGET_RESOLVED',
  'ACTION_STARTED',
  'ACTION_COMPLETED',
  'PRECONDITION_CHECKED',
  'POSTCONDITION_PASSED',
  'BUSINESS_OUTCOME_DETECTED',
  'RECOVERY_ATTEMPTED',
  'INTERVENTION_REQUESTED',
  'CONTROL_TRANSFERRED',
  'HUMAN_ACTION',
  'AUTOMATION_RESUMED',
  'CHECKPOINT_PASSED',
  'RUN_SUSPENDED',
  'RUN_RESUMED',
  'RUN_COMPLETED',
  'RUN_FAILED',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  type: RunEventTypeSchema,
  stepId: z.string().optional(),
  timestamp: z.string().datetime(),
  /** Pre-redacted before this object is constructed — see redact() in
   *  src/policy (Slice 2). Never contains raw sensitive input values. */
  data: z.record(z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;
