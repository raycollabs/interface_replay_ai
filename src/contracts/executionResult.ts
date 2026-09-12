import { z } from 'zod';

/**
 * Closed failure taxonomy. Forcing this to be an enum rather than a free
 * string is what makes "did you actually think about the failure space"
 * checkable by a reviewer in five seconds against this list, rather than
 * against whatever happened to get thrown.
 *
 * Note UNKNOWN_DIALOG and RISKY_IRREVERSIBLE-needs-approval are NOT here:
 * those are escalation triggers (-> needs_human), never failures. A run
 * only reaches `failure` for one of these codes, or reaches it via
 * ESCALATION_UNAVAILABLE when escalation itself could not be serviced
 * (e.g. UNATTENDED mode with no operator claiming within the lease TTL).
 */
export const FailureCodeSchema = z.enum([
  'PRECONDITION_UNMET',
  'TARGET_NOT_RESOLVED',
  'TARGET_AMBIGUOUS',
  'POSTCONDITION_UNMET',
  'CHECKPOINT_FAILED',
  'POLICY_DENIED',
  'SESSION_EXPIRED',
  'SESSION_LOST',
  'TIMEOUT',
  'ADAPTER_ERROR',
  'ESCALATION_UNAVAILABLE',
  'INPUT_CONTRACT_VIOLATION',
  'ARTIFACT_INCOMPATIBLE',
  'ARTIFACT_NOT_APPROVED_FOR_MODE',
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

/**
 * Four terminal-ish results, not three. `needs_human` exists because
 * escalation makes replay asynchronous: a suspended run is not a crash and
 * is not a completion, so it cannot be squeezed into success/outcome/failure
 * without losing information the caller needs (a resume handle).
 *
 * `success` / `business_outcome` / `failure` are genuinely terminal.
 * `needs_human` carries `runId` precisely because it is NOT terminal —
 * the caller (or an operator) resumes the same run later via that id.
 */
export const ExecutionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    outputs: z.record(z.unknown()),
    evidenceRef: z.string(),
  }),
  z.object({
    status: z.literal('business_outcome'),
    code: z.string(),
    stepId: z.string(),
    message: z.string(),
    outputs: z.record(z.unknown()).optional(),
    evidenceRef: z.string(),
  }),
  z.object({
    status: z.literal('needs_human'),
    runId: z.string(),
    interventionId: z.string(),
    reasonCode: z.string(),
    evidenceRef: z.string(),
  }),
  z.object({
    status: z.literal('failure'),
    code: FailureCodeSchema,
    stepId: z.string().optional(),
    expected: z.string().optional(),
    observed: z.string().optional(),
    evidenceRef: z.string(),
  }),
]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
