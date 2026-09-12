# Phase 2 — scaling to the real environment (design, not built)

This describes how the abstractions in this repo would extend to hundreds of tenants running ~20 apps each, many sharing the same vendor product. Per the brief's own guidance, none of this is implemented — building it would be premature scaling infrastructure, not sound abstraction design. What matters is that nothing in Slices 0–7 would need to change shape to get here.

## Capability resolution stays deterministic — no semantic/vector matching in the execution path

The tempting design is: natural-language intent → embedding search over saved capabilities → top-N candidates → policy filter → execute. Rejected, deliberately. Capability *selection* would then be as nondeterministic as capability *execution* is designed not to be — a 0.94-vs-0.82 similarity gap deciding which account gets read is exactly the failure mode this whole system exists to remove. Resolution stays a deterministic lookup: `(tenantId, capabilityId, applicationInstanceId) → exact immutable artifact version`, with a documented precedence chain (tenant binding → version variant → base capability). Intent-to-capability-name mapping belongs to the calling agent, which has the conversation and can ask a clarifying question — not to a matcher inside the execution platform with less context and no way to ask one. A `POST /capabilities/suggest` endpoint returning ranked candidates *for a human or agent to choose from*, with no path to execution, is the right shape if natural-language convenience is wanted at all.

## Session pooling, not a message queue, is the scaling primitive

The expensive, stateful resource is an authenticated browser session against one tenant's app instance — not a message. `SessionBroker` (Slice 5) is already that abstraction at N=1; scaling it is a keyed pool (`⟨tenant, app, authProfile⟩ → warm session`) with idle eviction and re-auth on expiry, plus affinity routing so work lands on the worker already holding the right warm session. A human-held session (mid-handoff) counts against that tenant's capacity — a real constraint a queue-based design would miss. Some legacy apps also cap concurrent sessions per account (`identity.maxConcurrentSessions`), which the pool has to enforce as a hard limit, not a soft preference.

A work queue in front of the pool is a reasonable implementation detail — keyed by `tenantId:applicationInstanceId` for locality, on a small number of shared topics (`capability.execution.requested`, `capability.execution.events`, `capability.intervention.*`), not one topic per tenant. Hundreds of topics buys partition-count churn, not the isolation it looks like it buys; real tenant isolation lives at the credential and network boundary (separate auth profiles, separate egress allowlists, ideally separate browser processes per tenant), which a topic name does nothing to enforce.

## Multi-tenant artifact reuse

Three layers, matching `targetRegistry`'s existing shape:

```
CapabilityDefinition        product-scoped, shared across every tenant on that vendor app
  → VersionVariant          per vendor app release; overrides labels/routes/known dialogs
    → TenantBinding         per tenant; entry URL, auth profile ref, small targetRegistry
                             overrides keyed by semanticPurpose, feature flags -- never credentials
```

`tenantId` never appears in `CapabilityDefinition` itself (true in this repo's schema today, not just the plan) — that separation is the entire reuse mechanism. A tenant override may narrow or redirect a target; it may not add steps or change the checkpoint. If a tenant genuinely needs different behavior, that's a new capability version, made visible, not a binding quietly diverging into a second undocumented flow.

## Drift detection

Two signals already exist in the schema and cost nothing extra to compute:
- **`recordedRung` vs. matched rung at replay** — a shift (rung 1 → rung 3) is a leading indicator that fires before a capability breaks outright.
- **`appFingerprint`** — a hash of the sorted `(role, accessibleName)` set at the checkpoint, computed once at compile/verify time and compared on later replays; deviation past a threshold flags `REVALIDATION_REQUIRED` rather than failing silently or triggering an automatic re-discovery.

A capability that proves stable across several tenants' overrides is a candidate for promotion into the base artifact — worth naming so the asset has a lifecycle, not just an execution path.

## Where a graph store would actually earn its place

Resolution is a bounded four-hop join (`tenant → binding → version → capability`) — a relational index over artifact files, not a graph problem. The genuinely graph-shaped question is the *impact* direction: "vendor ships v8 and renames a control — which capabilities, tenants, and scheduled runs does that affect?" That's reverse reachability with variable depth. At the scale described (hundreds of tenants × ~20 apps × a few dozen capabilities), that's comfortably a recursive CTE over Postgres; a graph database would earn its place only if that edge count grew far past what's described here, and the projection would still be built from Postgres via CDC, not treated as its own source of truth.

## Ten invariants that shouldn't change as this scales

1. The LLM does not control normal deterministic replay.
2. Every execution resolves to an exact, immutable capability version.
3. Every action passes through policy enforcement — no second door.
4. Tenant context is explicit on every execution, session, and binding; never on the capability itself.
5. Credentials are referenced, never transported in execution events.
6. Human takeover preserves the same live session.
7. A message transport carries events; it is never the system of record.
8. Capability *selection* stays deterministic; a similarity search may only ever suggest, never execute.
9. Approved artifact versions are immutable — a change is a new version.
10. Business outcomes remain distinct from technical failures, at every layer this scales through.
