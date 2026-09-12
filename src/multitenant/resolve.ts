import type { CapabilityDefinition, TenantBinding, Target } from '../contracts/index.js';

export interface ResolvedCapability {
  capability: CapabilityDefinition;
  /** The precedence chain that produced this resolution -- copied
   *  verbatim into RunState.resolvedFrom by the caller, so "why did this
   *  run use that locator" has a deterministic, auditable answer six
   *  months later (REPORT.md §4). */
  resolvedFrom: string[];
}

/**
 * Pure function: base capability + tenant binding -> the exact
 * CapabilityDefinition to replay. No I/O, no side effects -- callers load
 * the base artifact and the binding themselves (see scripts/replay-tenant.ts).
 *
 * Precedence: binding overrides win, per targetRegistry entry, entirely
 * (a binding replaces a purpose's candidates outright rather than
 * attempting a field-by-field merge -- a partial merge would let a stale
 * base-candidate silently coexist with a tenant's override in a way
 * nobody explicitly reviewed). `scope.allowedOrigins` is replaced with
 * the binding's `entryUrl` -- the capability's own scope stays the
 * ceiling (routes/action-types), but WHICH origin is a per-tenant fact,
 * not a capability fact.
 */
export function resolveCapability(base: CapabilityDefinition, binding: TenantBinding): ResolvedCapability {
  if (binding.baseCapabilityId !== base.capabilityId || binding.baseCapabilityVersion !== base.version) {
    throw new Error(
      `Binding for tenant "${binding.tenantId}" targets ${binding.baseCapabilityId}@${binding.baseCapabilityVersion}, ` +
        `not the supplied ${base.capabilityId}@${base.version}.`,
    );
  }

  const targetRegistry: Record<string, Target> = { ...base.targetRegistry };
  for (const [purpose, override] of Object.entries(binding.targetOverrides)) {
    const baseTarget = targetRegistry[purpose];
    if (!baseTarget) {
      throw new Error(
        `Tenant binding for "${binding.tenantId}" overrides purpose "${purpose}", which the base capability does not declare.`,
      );
    }
    targetRegistry[purpose] = {
      semanticPurpose: purpose as Target['semanticPurpose'],
      framePath: override.framePath ?? baseTarget.framePath,
      candidates: override.candidates,
      recordedRung: 0,
    };
  }

  const capability: CapabilityDefinition = {
    ...base,
    targetRegistry,
    scope: { ...base.scope, allowedOrigins: [binding.entryUrl] },
  };

  return {
    capability,
    resolvedFrom: [
      `${base.product.vendor}/${base.capabilityId}@${base.version}`,
      `binding:${binding.tenantId}/${binding.applicationInstanceId}`,
    ],
  };
}
