/**
 * Closed vocabulary of "what a control means", independent of its label, role,
 * or DOM position on any given tenant's variant of the app.
 *
 * This is the merge key for cross-tenant reuse: a TenantBinding overrides a
 * step's *target* (which strategy/label to use) but never its semantic
 * purpose. Tenant A's "Member ID" field and Tenant B's "Customer Number"
 * field are the same `member identifier input` — that identity is what lets
 * one base capability serve both without re-recording.
 *
 * Kept small and closed deliberately. An open/free-text vocabulary makes
 * cross-tenant alignment fail silently (two recordings invent two different
 * strings for the same concept); a closed enum makes misalignment a
 * compile-time or validation-time error instead.
 */
export const SEMANTIC_PURPOSES = [
  // Auth
  'login username input',
  'login password input',
  'login submit',
  'session reauth prompt',

  // Member search
  'member identifier input',
  'member search submit',
  'member search result row',
  'member not found banner',

  // Member detail / accounts
  'accounts navigation',
  'savings account row',
  'account balance field',
  'account currency field',
  'account identifier field',

  // Sub-account creation flow
  'sub-account create action',
  'sub-account type select',
  'sub-account nickname input',
  'sub-account confirm submit',
  'confirmation screen marker',

  // Cross-cutting error / dialog surfaces
  'permission denied banner',
  'validation error banner',
  'unknown dialog dismiss',
  'app error banner',
] as const;

export type SemanticPurpose = (typeof SEMANTIC_PURPOSES)[number];

export function isSemanticPurpose(value: string): value is SemanticPurpose {
  return (SEMANTIC_PURPOSES as readonly string[]).includes(value);
}
