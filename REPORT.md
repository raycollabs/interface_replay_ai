# Design Report — interface_replay_ai

## 1. Architecture

The system is a compiler and runtime for UI-driven capabilities, not a browser-agent demo. The lifecycle: an LLM discovers a flow once against a live surface; a compiler turns the successful trace into a typed, versioned capability artifact; a deterministic runtime executes that artifact in production with zero LLM calls; a session broker hands control to a human when automation cannot safely proceed.

**Modular monolith**, one package, logical boundaries under `src/`: `contracts` (Zod schemas — the single source of truth for every other module), `surface` (the Playwright adapter and targeting ladder), `policy` (allowlist + redaction), `replay` (the deterministic engine), `discovery` (the agent loop), `compiler` (trace → artifact), `session` (the handoff broker). No physical service boundaries — the brief is explicit that scaling infrastructure isn't rewarded, and a single process is easier to reason about end to end.

**`SurfaceAdapter` is the sole extensibility and enforcement seam.** `perform()` is the only method that touches the live page, and it calls `policy.evaluate()` internally before acting. Neither the replay engine nor the discovery loop has a code path to the browser that skips this check — that's what makes the guardrail structural rather than conventional, and it's the same claim that makes the prompt-injection containment argument in §6 concrete rather than aspirational.

**Replay is a suspendable state machine, not a blocking function call.** Escalation makes replay asynchronous — a run can be stuck for however long a human takes to respond, and closing the browser at that point would break the entire premise of a same-session handoff. `RunState` is persisted to disk after every step boundary; `ReplayRun.escalate()` and `regroundAfterResume()` are the single ownership-transfer and re-derivation path shared by every "can't safely proceed" site in the engine.

**Set-of-marks grounding is discovery-only**, moved there deliberately after starting to build it during the adapter slice: deterministic replay resolves declared target strategies directly and never needs to enumerate or number controls for a model to pick from. Building it ahead of its only consumer would have been speculative; it was built when discovery actually needed it.

**Out-of-process browser via real CDP, not `launchServer()`+`connect()`.** This looked like the obvious multi-client primitive and isn't one — verified directly with a throwaway script that a second `connect()` call to a `launchServer()` browser gets an isolated view with zero contexts, even though the first client's context demonstrably still exists. That pairing is for *sequential* reuse across test runs, the opposite of what a same-session handoff needs. Chromium is launched with `--remote-debugging-port` exposed instead, and both the replay worker and the operator console attach via `chromium.connectOverCDP()` — confirmed with a second throwaway script that this genuinely shares contexts across simultaneous independent clients before anything was built on top of the assumption.

## 2. Artifact schema

The artifact is an API contract whose implementation happens through UI automation, not a step recording. Four things separate it from a script dump:

**`targetRegistry` is the single place every semantic purpose resolves to a concrete strategy.** This wasn't the original design — early on, conditions (checkpoint, known outcomes, interstitials) referenced a control by `semanticPurpose` alone with no way to actually resolve it, since only a step's own target carried a strategy. Centralizing resolution here is also the tenant-override seam (§4): a `TenantBinding` overrides registry entries, never step or condition bodies.

**Conditions are structured discriminated unions, never strings.** `{type: 'controlVisible', semanticPurpose: 'account balance field'}`, not `"balance is showing"`. A string condition forces either unsafe `eval`-style interpretation or an undocumented expression DSL, and both couple the schema to one surface. A structured condition compiles to a DOM query today and a UIA element check tomorrow without the schema changing.

**Every target carries a typed strategy per candidate, ordered by preference, plus the frame it resolves in.** `frame Path` sits on the target, not nested inside one strategy variant — frame context applies to every candidate for a control, not just structural ones. Rungs 2–3 (`role_and_name`, `associated_label`) port directly to a desktop accessibility API; the last rung (`visible_text`) does not, and the schema makes that portability boundary explicit rather than implicit.

**`knownOutcomes` are declared, not caught.** "No such member" is a named, detectable, typed result the caller can see before invoking the capability — the direct fix for what the brief names as the most common design mistake in this space.

**Scope is a ceiling, not a grant.** A capability declares its own minimum `allowedOrigins/Routes/ActionTypes`; effective policy at runtime is `tenantAllowlist ∩ capability.scope`, so a balance-read capability cannot reach a mutation route even if the tenant's allowlist would otherwise permit it.

**`assistedRepair` is capability-level, disabled by default, and capped at one step.** Per-step `onBlock` is only `escalate | fail` — there is no per-step enum value that quietly reintroduces open-ended LLM control into the default replay path.

## 3. Determinism & error handling

**The targeting ladder tries candidates in declared order and stops at the first exactly-one match.** More than one match returns `ambiguous` immediately rather than falling through to a weaker strategy — ambiguity at replay means the app changed since compile, not something to paper over.

**Business-outcome probes are evaluated before postconditions, at every step boundary — not as a fallback when a postcondition fails.** Verified directly: replaying with a nonexistent member ID, the not-found banner is detected at the search-submit step and returned as `MEMBER_NOT_FOUND` immediately, before the engine ever evaluates the postcondition that would technically also hold, and before it attempts the next step (which doesn't exist on that page). This ordering is the concrete difference between conflating a legitimate result with a broken step and not.

**The result contract has four arms, not three**, because escalation is asynchronous: `needs_human` carries a `runId` specifically because it isn't terminal.

**Compile-time uniqueness is enforced live, not asserted.** The compiler replays a discovery trace's actions against a real page and calls the same `resolveTarget()` the replay engine uses; a target is only written into the artifact after it resolves to exactly one match.

Several real defects were found by reading raw evidence rather than trusting a green result, each fixed at the root:

- **`launchServer`+`connect` isolation** (§1) — would have silently broken the entire handoff mechanism if not caught before building on top of it.
- **Re-grounding checked a postcondition exactly once.** An operator's action can trigger a redirect or iframe reload still settling in the instant a resume signal fires; fixed by re-deriving position with the same bounded `waitForCondition` every other postcondition already uses.
- **A goal string leaked a raw sensitive value.** Phrasing a discovery goal as "Look up member 12345…" let the value echo back through the model's own `finish()` output; fixed with a pre-flight guard refusing to launch if a goal contains a raw sensitive value verbatim, plus redaction at every terminal result boundary, not only the trace.
- **A vision-channel leak the placeholder mechanism cannot close.** Even after the fix above, the model still read a member's name and ID directly off a screenshot — the target app's own detail page renders the ID back on screen, a realistic thing for a banking app to do. The `{{inputs.NAME}}` substitution protects the control plane (nothing *we* construct ever contains the raw value); it cannot prevent a vision-capable agent from seeing whatever the target application renders back, which a human operator would see too. Documented as an accepted, mitigated limit — output-boundary redaction catches it before persistence — not a silently assumed non-issue.
- **The compiled artifact had no postconditions at all**, and failed its own verification replay as a direct result. Fixed with a general heuristic sound for any linear discovery trace: every click step's postcondition is that the next step's target becomes visible.
- **`risky_irreversible` under `ATTENDED` mode**, caught by my own test suite assuming the wrong behavior: "attended" means a human is present and able to intervene, not that this specific irreversible action was pre-approved. The policy engine now returns `require_human` for this risk class regardless of mode.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `SurfaceAdapter`'s five methods (`perform`, the discovery-time action variants, `resolveTarget`, `captureEvidenceScreenshot`) are the only things that know what a browser is. A desktop adapter would implement the identical interface against UI Automation: `ObservedControl`'s `{role, accessibleName, framePath}` shape is exactly what UIA's `AutomationElement` tree already exposes, so rungs 2–3 of the targeting ladder port unchanged. Rung 5 (`structural_semantic`) becomes a control-tree traversal instead of a DOM table walk. The last rung (`visible_text`) has no desktop analogue and the schema flags it rather than claiming universal portability.

**Multi-tenant reuse.** The capability belongs to the vendor product, never to a tenant — `tenantId` does not appear anywhere in `CapabilityDefinitionSchema`, by construction. The intended resolution model is three layers: `CapabilityDefinition` (product-scoped, shared across every tenant running that product) → a version-variant layer for a vendor's own app releases → a `TenantBinding` carrying only specialization (entry URL, auth profile reference, small target-registry overrides keyed by the same `semanticPurpose` strings, feature flags — never credentials). Resolution is `tenant → binding → version variant → base capability`, with a documented precedence merge, and `resolvedFrom[]` is already recorded in run evidence (`RunState.resolvedFrom`) so "why did this run use that locator" has a deterministic, auditable answer. This model is designed and the schema is shaped not to paint it into a corner (`targetRegistry` is exactly the override seam); the `TenantBinding` layer itself is not built in this submission — see §7.

**Drift detection has a leading indicator already in the schema.** Each target records `recordedRung` — which candidate matched — and a real replay's matched rung is compared against it; a shift from rung 1 to rung 3 is a drift signal that fires before a capability actually breaks. `provenance.appFingerprint` (a hash of the sorted `(role, accessibleName)` set observed at the checkpoint, computed by the compiler and populated in both artifacts in this repo) is the coarser, whole-capability version of the same idea.

## 5. Escalation & handoff

**Detection.** Three conditions ever escalate: a policy `require_human` decision, an unresolvable target/postcondition on a step declared `onBlock: escalate`, and a declared interstitial whose handler is `escalate` (a fixture is included, member `33333`, that is deliberately *not* auto-recoverable — distinct from member `44444`'s visually similar but auto-dismissable notice, to prove the system distinguishes "recoverable automatically" from "needs a human decision" rather than always guessing or always stopping).

**Ownership is a real state machine, tracked separately from run status.** `ControlOwner` (`AUTOMATION | HUMAN | NONE`) and `RunStatus` are two axes, not one — `NONE` is the real transitional state between automation releasing and an operator claiming, and it's also what a crashed run or an expired lease leaves behind. The sequence, verified end to end: `AUTOMATION → NONE → HUMAN → NONE → AUTOMATION`.

**Take control is genuinely the same live session**, not a fresh one, because the browser is out-of-process with a real CDP endpoint (§1). The operator console is a second, independent OS process (`npm run operator`) that attaches via `connectOverCDP`, sees the identical page the replay worker suspended on, and acts on it directly — verified by reading the before/after screenshots the operator's own action produced.

**The minimal operator console is deliberately bare** — server-rendered HTML, no JS framework, per the brief's own scope note that a full co-browsing console is out of scope. What's real is the mechanism: viewing an intervention claims it; a quick-action button resolves and clicks an actual registered control on the live session; Resume, with a required operator note, flips one field (`intervention.json`'s `status`) that the suspended worker is polling for.

**Resume never assumes position — it re-derives it.** `regroundAfterResume()` re-checks business outcomes and the step's own declared condition against live page state, and deliberately does *not* re-attempt the step's action: the human's job during their control window was to clear the blocking condition directly, not approve an automated retry. This matters most for a `risky_irreversible` step specifically — auto-retrying after a human's involvement would risk double-submitting the exact class of action this mechanism exists to gate. A resume that didn't actually fix anything surfaces as a failure rather than looping into a second escalation, keeping the state machine bounded.

**Audit.** Every human action — a click, the resume note — is logged as a `HUMAN_ACTION` event in the same `events.jsonl` the automation's own steps write to, and the note is copied into `RunState.operatorNotes`.

## 6. Safety

**Enforcement is structural, not conventional.** Every action — from replay, from discovery, and from the engine's own interstitial-recovery logic — routes through `SurfaceAdapter.perform()` (or its discovery-time equivalents), which calls `policy.evaluate()` before touching the page. There is no second door.

**A click's own resulting navigation is re-checked against the allowlist.** A form submit or redirect triggered by a click was never itself requested as a `navigate` step, so it was never policy-checked as one; if the URL changes after a click, the new route is checked too. This is the concrete, code-level form of the prompt-injection containment argument: a hijacked or unexpectedly-redirecting control cannot walk a run out of scope, because the policy layer sits below anything a page — or an injected instruction inside it — could produce, and doesn't read page content to begin with.

**`risky_irreversible` always requires an explicit, in-the-moment human decision**, in both attended and unattended mode (§3) — "attended" means a human is present and able to intervene, not that a specific irreversible action was pre-approved.

**Redaction happens at capture, never at write.** Sensitive-bound form controls are switched to a masked input type in the live DOM immediately before a screenshot and restored immediately after — the file never contains the rendered value. Typed sensitive values cross from placeholder to real value only inside `perform()`, below the logging boundary. Discovery's terminal results are redacted before being persisted *or* returned, not only the per-step trace (§3).

**Known, accepted limit:** the vision channel (§3) — a screenshot-reading agent can see whatever the target application itself renders back, the same as a human operator would. This is not preventable by the placeholder mechanism by construction; it's mitigated by redacting every output at the persistence boundary.

**Discovery-time risk containment relies on a narrow allowlist rather than per-action risk classification** — raw discovery has no declared `riskClass` to check the way a compiled step does, so containment for an exploring agent is scope-based: no mutating route is even declared reachable for a read-only goal, rather than trusting a real-time risk judgment on an action the compiler hasn't classified yet. Documented as a scope limit for this project rather than a general answer.

## 7. Cuts

Deliberately not built, and why:

- **Production session pooling, queues, multi-tenant plumbing.** The brief explicitly does not reward this; the `SessionBroker` here is the correct abstraction at N=1, and scaling it is a keyed pool and an eviction policy, not a different execution model (see `docs/phase-2-scale.md`).
- **The `TenantBinding` layer itself.** The schema and resolution model are designed not to be painted into a corner (§4), but no second tenant, override file, or resolver function is implemented in this submission.
- **`knownOutcomes`/`interstitials` in the compiled artifact are empty.** A single happy-path discovery run has no way to discover a not-found banner or a dialog it never encountered. A real pipeline would merge multiple discovery runs, or accept hand-authoring for these — exactly what the v1 hand-authored artifact demonstrates.
- **The `reauth` interstitial handler is a declared no-op.** It exists in the schema and is referenced by both artifacts for completeness, but there's no real credential-refresh flow behind it.
- **A general compiler CLI.** `scripts/compile.ts` hardcodes this capability's output schema; the compilation *logic* (`src/compiler/index.ts`) takes it as a typed parameter and is fully generic.
- **The capability catalog (agent-facing tool exposure).** Zod already emits JSON Schema for every artifact (`docs/capability.schema.json`); exposing saved capabilities as Claude tool definitions and invoking one by name is the natural next stretch goal, not yet built.
- **Desktop adapter.** The interface is designed to accommodate one (§4); no implementation exists.

What I'd build next, in order: the capability catalog (closes the loop on "a capability an AI agent can call," and is nearly free given the schema already emits JSON Schema); a thin `TenantBinding` + variant-B demonstration; multi-run stability scoring on top of the verification harness that already exists; bounded single-step assisted repair (the schema already reserves the field); production secrets and evidence-retention controls.
