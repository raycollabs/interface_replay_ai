import type { Allowlist, PolicyDecision, ProposedAction, RiskClass } from '../contracts/index.js';

const RISK_ORDER: RiskClass[] = [
  'read_only',
  'safe_reversible',
  'mutating_reversible',
  'risky_irreversible',
];

function riskRank(r: RiskClass): number {
  return RISK_ORDER.indexOf(r);
}

export interface PolicyContext {
  allowlist: Allowlist;
  mode: 'ATTENDED' | 'UNATTENDED';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Two pattern styles, both supported: `*` matches any run of characters
 * (hand-authored artifacts, e.g. `/member/*`), and a `:name` path
 * segment matches exactly one segment, no slashes (compiler-derived
 * patterns from canonicalizeRoute, e.g. `/member/:memberId`). Found and
 * fixed for real: the compiler started emitting `:memberId`-style routes
 * without this matcher understanding them, which would have made a
 * compiled artifact's own derived scope fail its own policy check at
 * replay time -- caught before it shipped, not after.
 */
function matchesPattern(value: string, pattern: string): boolean {
  const regexSource = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.split('*').map(escapeRegex).join('.*')))
    .join('/');
  const regex = new RegExp('^' + regexSource + '$');
  return regex.test(value);
}

/**
 * The single policy decision function. This is called from INSIDE
 * SurfaceAdapter.perform() (see src/surface/adapter.ts) — there is no other
 * code path from the discovery loop or the replay engine to the live
 * surface. That placement, not this function's logic, is what makes the
 * guardrail structural rather than conventional: injected page content
 * cannot produce an out-of-allowlist navigation or a disallowed action
 * type, because whatever decided to act still has to pass through here
 * before anything touches the browser.
 *
 * Effective policy at runtime is `tenantAllowlist ∩ capability.scope`
 * (the caller is expected to have already intersected the two into a
 * single Allowlist before constructing PolicyContext — see
 * intersectWithCapabilityScope below).
 */
export function evaluatePolicy(action: ProposedAction, ctx: PolicyContext): PolicyDecision {
  if (!ctx.allowlist.allowedActionTypes.includes(action.actionType)) {
    return { decision: 'deny', reason: `Action type "${action.actionType}" is not in the allowlist.` };
  }

  if (action.targetUrl) {
    const originOk = ctx.allowlist.allowedOrigins.some((o) => action.targetUrl!.startsWith(o));
    if (!originOk) {
      return { decision: 'deny', reason: `Origin of "${action.targetUrl}" is not allowlisted.` };
    }
  }

  if (action.route) {
    const routeOk = ctx.allowlist.allowedRoutes.some((p) => matchesPattern(action.route!, p));
    if (!routeOk) {
      return { decision: 'deny', reason: `Route "${action.route}" is not allowlisted.` };
    }
  }

  if (action.riskClass) {
    // risky_irreversible ALWAYS produces require_human, in both ATTENDED
    // and UNATTENDED mode. "Attended" means a human is present and able to
    // intervene -- it is not the same as "this specific irreversible
    // action was approved". The two modes differ only in what the replay
    // engine does with a require_human decision afterward: an attended
    // run surfaces a fast in-session approval prompt to the operator
    // already watching; an unattended run cold-suspends and pages someone
    // in. The policy decision itself never varies by mode for this class.
    if (action.riskClass === 'risky_irreversible') {
      return {
        decision: 'require_human',
        reason: 'risky_irreversible actions always require an explicit, in-the-moment human decision.',
      };
    }
    if (
      ctx.mode === 'UNATTENDED' &&
      riskRank(action.riskClass) > riskRank(ctx.allowlist.unattendedRiskCeiling)
    ) {
      return {
        decision: 'require_human',
        reason: `Risk class "${action.riskClass}" exceeds the unattended ceiling "${ctx.allowlist.unattendedRiskCeiling}".`,
      };
    }
  }

  return { decision: 'allow' };
}

/**
 * Effective policy = tenantAllowlist ∩ capability.scope. A capability's
 * declared scope is a ceiling, never a grant: a balance-read capability
 * cannot reach a wire-transfer route even if the tenant allowlist happens
 * to permit it, because its own scope never included that route.
 */
/**
 * Simplified as exact-pattern-string intersection: a tenant allowlist entry
 * only survives if the capability scope declares that identical pattern.
 * This is sufficient while tenant and capability declare matching literal
 * patterns (true for Slice 2/3's single-tenant setup); real cross-tenant
 * pattern-set intersection (e.g. tenant allows "/member/*" and a capability
 * declares "/member/*\/accounts" as a narrower pattern) is a Slice 8
 * concern, not implemented here.
 */
export function intersectWithCapabilityScope(
  tenantAllowlist: Allowlist,
  capabilityScope: { allowedOrigins: string[]; allowedRoutes: string[]; allowedActionTypes: string[] },
): Allowlist {
  return {
    allowedOrigins: tenantAllowlist.allowedOrigins.filter((o) => capabilityScope.allowedOrigins.includes(o)),
    allowedRoutes: tenantAllowlist.allowedRoutes.filter((r) => capabilityScope.allowedRoutes.includes(r)),
    allowedActionTypes: tenantAllowlist.allowedActionTypes.filter((a) =>
      capabilityScope.allowedActionTypes.includes(a),
    ) as Allowlist['allowedActionTypes'],
    unattendedRiskCeiling: tenantAllowlist.unattendedRiskCeiling,
  };
}
