import { z } from 'zod';
import { TargetSchema } from './target.js';

/**
 * A TenantBinding carries only specialization -- entry point, credential
 * reference, and small per-purpose target overrides -- never a copy of
 * the capability itself. This is the whole multi-tenant reuse mechanism
 * described in REPORT.md §4: the base CapabilityDefinition never mentions
 * a tenant; a binding is what lets the SAME artifact run against a
 * differently-labeled, differently-hosted instance of the same vendor
 * product.
 *
 * `targetOverrides` is keyed by `semanticPurpose` -- the same key
 * `targetRegistry` uses -- specifically so a binding can only ever
 * override *how a control is found*, never add a step, change the
 * checkpoint, or introduce a new capability behavior. If a tenant needs
 * more than that, it needs its own capability version, not a binding
 * that quietly diverges into an undocumented second flow (see
 * docs/phase-2-scale.md).
 */
export const TenantBindingSchema = z.object({
  tenantId: z.string(),
  applicationInstanceId: z.string(),
  baseCapabilityId: z.string(),
  baseCapabilityVersion: z.number().int().positive(),
  entryUrl: z.string(),
  /** A reference, never a credential -- see REPORT.md §6 and
   *  src/policy/redact.ts. Resolving this to real material is a
   *  SessionBroker/secrets-manager concern, out of scope here. */
  authProfileRef: z.string(),
  targetOverrides: z.record(
    z.string(),
    TargetSchema.omit({ semanticPurpose: true }).partial({ framePath: true, recordedRung: true }),
  ),
  featureFlags: z.record(z.string(), z.boolean()).default({}),
});
export type TenantBinding = z.infer<typeof TenantBindingSchema>;
