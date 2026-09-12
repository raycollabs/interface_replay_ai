# Implementation slices

Ordering principle: reach a complete, correct vertical thread through every
production layer before deepening any one layer. Breadth of *shape* is not
cut (all four `ExecutionResult` arms, the full failure enum, the complete
`SurfaceAdapter` interface all exist from the slice that introduces them,
even where a method is a stub); breadth of *instances* is cut (one
business outcome, one interstitial, one recovery strategy is enough to
prove the mechanism).

- [x] **Slice 0 — Contracts.** Zod schemas for the capability artifact,
  execution result (4-arm union), run state machine, policy decision,
  intervention request, evidence events. Hand-written sample artifact.
  Gate: sample validates; JSON Schema emitted; a reviewer who hasn't seen
  the code can read the schema and say what the capability does, needs,
  and returns.

- [x] **Slice 1 — Target app, happy path.** Local legacy-style banking demo:
  login, member search, member detail, accounts, savings balance.
  Table layout, no test IDs, member-ID field labeled by adjacent `<td>`
  with no `for`/`aria` association (deliberately broken — forces the
  associated_label fallback to actually fire on every real replay, not
  just declared in principle). Account fields render inside a named
  iframe (`accounts-frame`), a genuine frame-traversal case. No error
  routes yet (added in Slice 4). Gate: full happy path walked end-to-end
  via curl with a cookie jar (login -> search -> detail -> accounts ->
  iframe balance data); unknown member returns 404.
  Surfaced a schema gap fixed in this slice: conditions (checkpoint,
  known outcomes, interstitials) referenced a control by `semanticPurpose`
  alone with no way to resolve it. Added `targetRegistry` — the one place
  every purpose resolves to a concrete strategy + frame context — and
  moved `framePath` from the `structural_semantic` strategy variant up to
  the target level, since frame context applies to every candidate
  strategy for a control, not just the structural one.

- [x] **Slice 2 — Surface adapter + policy.** Out-of-process Playwright
  browser (`launchServer`+`connect`, stable `wsEndpoint` — built now so
  Slice 5's handoff is additive, not a retrofit; headless by default,
  flipped for the actual handoff demo). `resolveTarget()` implementing
  the ladder (rungs 2/3/5 exercised for real against the target app;
  6/7 implemented but not yet exercised by any capability), `perform()`
  with the policy check *inside it* (no other path to the surface),
  `checkCondition`/`waitForCondition` (the one form of waiting anywhere —
  no unconditional sleeps), `captureEvidenceScreenshot()` masking
  sensitive-bound controls in the live DOM immediately before the
  screenshot. Placeholder substitution happens inside `perform()`, below
  the logging boundary.
  Gate (`npm run smoke:adapter`): a hardcoded step sequence sourced from
  the artifact drives the real target app end-to-end with zero LLM and
  zero replay engine — login, search, navigate, extract, checkpoint. The
  member-ID field's rung-1 (role_and_name) candidate genuinely fails to
  resolve (no label association in the real markup) and the ladder falls
  through to rung 2 (associated_label) for real, exactly as the
  artifact's own rationale predicted. An out-of-allowlist route is denied
  before a browser is even launched.
  Scope correction from the original plan: `observe()`'s set-of-marks
  grounding (numbered badges + `ObservedControl[]` inventory) is a
  discovery-time concern only — deterministic replay resolves declared
  target strategies directly and never needs to enumerate or number
  controls for a model to choose from. Moved into Slice 6, where it's
  actually needed, rather than building it ahead of any consumer.

- [ ] **Slice 3 — Replay engine + run state. The walking skeleton.** The
  hardcoded array becomes artifact-driven. Step loop, precondition /
  postcondition waits (no unconditional sleeps anywhere), checkpoint
  verification, output extraction, the four-arm result, durable run state
  written after every step, an `llmCalls === 0` assertion test. Gate:
  `npm run replay -- --capability member.read-savings-balance --input memberId=12345`
  returns `{status:"success", outputs:{...}}` with evidence saved.
  **End of this slice = a complete vertical thread through every
  production layer, with no LLM in the repo.**

- [ ] **Slice 4 — Error taxonomy, one instance per class.** Add to the
  target app: a not-found member, a slow route, an unknown dialog. Add to
  replay: business-outcome probes evaluated *before* postconditions, one
  bounded recovery handler, failure classification. Gate: three evidence
  directories (`replay-business-outcome`, `replay-recovered`,
  `replay-failure`), each correctly classified.

- [ ] **Slice 5 — Session broker + handoff.** Lease state machine with
  `NONE` as a real transitional owner state, TTL + heartbeat,
  `InterventionRequest`, minimal HTML operator page, CDP handback to the
  *same* browser context, tracing across the transfer, re-grounding on
  resume (re-derive position from preconditions/postconditions, never
  assume it), required operator note. Gate: the unknown-dialog case
  suspends the run, an operator claims it, dismisses the dialog in the
  same session, resumes, automation re-grounds and completes. Ownership
  log shows `AUTOMATION -> NONE -> HUMAN -> NONE -> AUTOMATION`.
  `REPORT.md` drafted from this point on, not written cold at the end.

- [ ] **Slice 6 — Discovery loop.** `observe()`'s set-of-marks grounding
  (numbered badges over interactive controls + `ObservedControl[]`
  inventory) lands here — moved from Slice 2, since replay never needs it
  and building it ahead of its only consumer would have been speculative.
  Claude, native tool use, forced `tool_choice`, prompt caching on the
  static prefix, images truncated to the last 2-3 turns, stop conditions
  (max steps / timeout / repeated state). *(Opus fork for the tool/prompt
  design pass — this is the one genuinely open-ended slice.)* Gate: one
  real run completes the goal against the live target app; evidence
  saved. This is the one thing that cannot be faked, per the brief —
  banked before further polish.

- [ ] **Slice 7 — Compiler + verification gate.** Trace -> artifact.
  Compile-time uniqueness assertion (ambiguity must not reach production).
  Second LLM pass with fresh context proposes checkpoint + output
  extraction. `DRAFT -> VERIFIED` gated on a green replay using
  **different** input values than discovery used — the mechanical proof
  that the compiler parameterized rather than transcribed.

- [ ] **Slice 8 — Multi-tenant resolution.** Variant B of the target app
  (different labels/branding). `TenantBinding` JSON, pure
  `resolveCapability(tenantId, capabilityId)` with a documented precedence
  merge, `resolvedFrom[]` recorded in run evidence. Gate: the same base
  capability runs green against both variants via binding overrides only —
  no re-recording.

- [ ] **Slice 9 — Catalog stretch + docs.** Zod -> JSON Schema -> Claude
  tool definitions; one invocation by capability name with typed args,
  closing the loop on "a capability an AI agent can call." Finish
  `REPORT.md`, `README.md`, `docs/phase-2-scale.md`.
