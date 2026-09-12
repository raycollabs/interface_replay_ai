import { z } from 'zod';
import { ActionTypeSchema, RiskClassSchema } from './capability.js';

export const ProposedActionSchema = z.object({
  actionType: ActionTypeSchema,
  targetUrl: z.string().optional(),
  route: z.string().optional(),
  riskClass: RiskClassSchema.optional(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/**
 * The engine's only output is allow/require_human/deny — never a partial
 * "allow but log a warning". This is called from inside
 * SurfaceAdapter.perform() so there is no code path to the live surface
 * that skips it (Slice 2). That placement is what makes the guardrail
 * structural rather than conventional: the discovery LLM cannot act
 * outside policy because it has no route to the surface that bypasses it.
 */
export const PolicyDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  z.object({ decision: z.literal('require_human'), reason: z.string() }),
  z.object({ decision: z.literal('deny'), reason: z.string() }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/**
 * Effective policy at runtime is `tenantPolicy ∩ capability.scope`
 * (capability.scope defined in capability.ts). This type is the tenant
 * side of that intersection.
 */
export const AllowlistSchema = z.object({
  allowedOrigins: z.array(z.string()),
  allowedRoutes: z.array(z.string()),
  allowedActionTypes: z.array(ActionTypeSchema),
  /** The highest risk class permitted to execute without a human able to
   *  approve in real time. risky_irreversible always requires attended
   *  mode or an explicit approval token, regardless of this setting. */
  unattendedRiskCeiling: RiskClassSchema.default('safe_reversible'),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;
