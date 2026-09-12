import { z } from 'zod';

/**
 * Carries what an operator needs to act: which capability/goal, where it
 * stopped, why, and what the app currently shows. `screenshotRef` points
 * into /evidence — screenshots are masked at capture (Slice 2) before an
 * InterventionRequest can ever reference one, so this object never becomes
 * a vector for leaking sensitive fields to an operator who lacks tenant
 * authorization for them.
 */
export const InterventionRequestSchema = z.object({
  interventionId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  capabilityId: z.string().optional(),
  goal: z.string().optional(),
  stepId: z.string().optional(),
  reasonCode: z.string(),
  explanation: z.string(),
  screenshotRef: z.string(),
  observationRef: z.string().optional(),
  allowedHumanActions: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  status: z.enum(['open', 'claimed', 'resolved', 'expired']).default('open'),
  claimedBy: z.string().optional(),
});
export type InterventionRequest = z.infer<typeof InterventionRequestSchema>;
