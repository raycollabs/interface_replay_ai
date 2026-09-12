import { z } from 'zod';

/**
 * Run lifecycle and control ownership are orthogonal axes — deliberately
 * kept as two separate enums rather than folded into one
 * AUTOMATION|HUMAN|PAUSED union. A run can be RUNNING while owned by
 * AUTOMATION, or SUSPENDED_AWAITING_HUMAN while owned by NONE (the instant
 * after automation releases and before an operator claims — also what a
 * crashed run or an expired lease leaves behind). Conflating the two makes
 * that transitional state inexpressible.
 */
export const RunStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUSPENDED_AWAITING_HUMAN',
  'SUCCEEDED',
  'BUSINESS_OUTCOME',
  'FAILED',
  'ABANDONED', // lease TTL expired with no operator claim, in a mode with no auto-fail path
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ControlOwnerSchema = z.enum(['AUTOMATION', 'HUMAN', 'NONE']);
export type ControlOwner = z.infer<typeof ControlOwnerSchema>;

export const RunModeSchema = z.enum(['ATTENDED', 'UNATTENDED']);
export type RunMode = z.infer<typeof RunModeSchema>;

/**
 * Durable run state, written after every step boundary. This is what
 * makes replay a suspendable state machine instead of a blocking function
 * call — a run can be rehydrated by runId after a crash or an unbounded
 * human-latency escalation. It also doubles as the audit record: the
 * resolution chain and operator notes below are exactly what a regulated
 * environment needs to answer "why did this run do that" after the fact.
 */
export const RunStateSchema = z.object({
  runId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.number().int(),
  inputs: z.record(z.unknown()),
  cursor: z.number().int().min(0),
  status: RunStatusSchema,
  mode: RunModeSchema,
  lease: z.object({
    owner: ControlOwnerSchema,
    leaseId: z.string().nullable(),
    heldSince: z.string().datetime().nullable(),
    ttlMs: z.number().int().positive(),
  }),
  /**
   * The tenant/version/binding resolution chain that produced the exact
   * artifact this run executed, e.g.
   * ["vendor-x/member.read-balance@1", "variant:vendor-x@v8", "binding:bank-a"].
   * Recorded so "why did this run use that locator" has a deterministic
   * answer six months later (Slice 8).
   */
  resolvedFrom: z.array(z.string()).default([]),
  operatorNotes: z
    .array(
      z.object({
        timestamp: z.string().datetime(),
        operatorId: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RunState = z.infer<typeof RunStateSchema>;
