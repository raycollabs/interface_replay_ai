# Design Report — interface_replay_ai

## 1. Architecture

The system is a compiler and runtime for UI-driven capabilities, not a browser-agent demo: an LLM discovers a flow once; a compiler turns the successful trace into a typed, versioned capability artifact; a deterministic runtime executes that artifact in production with zero LLM calls; a session broker hands control to a human when automation cannot safely proceed.

**Modular monolith**, one package, logical boundaries under `src/`: `contracts` (Zod — the single source of truth every other module types against), `surface` (adapter + targeting ladder), `policy` (allowlist + redaction), `replay` (the deterministic engine), `discovery` (the agent loop), `compiler` (trace → artifact), `session` (the handoff broker). No physical service boundaries — the brief is explicit that scaling infrastructure isn't rewarded.

**`SurfaceAdapter` is the sole extensibility and enforcement seam.** `perform()` is the only method that touches the live page, and it calls `policy.evaluate()` internally before acting. Neither replay nor discovery has a path to the browser that skips this — the guardrail is structural, not conventional, which is what makes §6's injection-containment claim concrete rather than aspirational.

**Replay is a suspendable state machine, not a blocking call**, because escalation makes it asynchronous — closing the browser while a human is still deciding would break the entire premise of a same-session handoff. `RunState` persists after every step boundary; `escalate()`/`regroundAfterResume()` are the one ownership-transfer path shared by every "can't safely proceed" site in the engine.

**Set-of-marks grounding is discovery-only**, moved there after starting to build it during the adapter slice: deterministic replay resolves declared strategies directly and never needs to enumerate controls for a model to choose from.

**Out-of-process browser via real CDP, not `launchServer()`+`connect()`.** The latter looks like the obvious multi-client primitive and isn't one — verified directly that a second `connect()` call to a `launchServer()` browser gets an isolated view with zero contexts, even though the first client's context still exists. That pairing is for *sequential* reuse across test runs, the opposite of a same-session handoff. Chromium is launched with `--remote-debugging-port` exposed instead; both the replay worker and the operator console attach via `connectOverCDP()` — confirmed separately that this genuinely shares contexts across simultaneous clients before anything was built on top of the assumption.

## 2. Artifact schema

An API contract whose implementation happens through UI automation, not a step recording.

**`targetRegistry` is the single place every semantic purpose resolves to a strategy.** Not the original design — conditions (checkpoint, outcomes, interstitials) initially referenced a `semanticPurpose` with no way to resolve it, since only a step's own target carried one. This registry is also the tenant-override seam (§4): a binding overrides entries, never step or condition bodies.

**Conditions are structured discriminated unions, never strings** — `{type:'controlVisible', semanticPurpose:'account balance field'}`, not `"balance is showing"`. A string forces `eval`-style interpretation or an undocumented DSL and couples the schema to one surface; a structured condition compiles to a DOM query today and a UIA check tomorrow unchanged.

**Every target carries typed strategies, ordered by preference, plus the frame it resolves in** — `framePath` sits on the target, not one strategy variant, since frame context applies to every candidate. Rungs 2–3 (`role_and_name`, `associated_label`) port directly to a desktop accessibility API; the last rung (`visible_text`) doesn't, and the schema flags that rather than hiding it.

**`knownOutcomes` are declared, not caught** — "no such member" is a named, typed result visible before invocation, the direct fix for the brief's own named most-common mistake.

**Scope is a ceiling, not a grant**: effective policy is `tenantAllowlist ∩ capability.scope`, so a balance-read capability can't reach a mutation route even if the tenant's own allowlist would permit it.

**`assistedRepair` is capability-level, off by default, capped at one step.** Per-step `onBlock` is only `escalate | fail` — no enum value quietly reintroduces open-ended LLM control into the default path.

## 3. Determinism & error handling

**The targeting ladder tries candidates in order and stops at the first exactly-one match.** More than one match returns `ambiguous` immediately rather than falling through to a weaker strategy — ambiguity at replay means the app changed since compile, not something to guess past.

**Business-outcome probes are evaluated before postconditions, at every step boundary — not as a fallback when one fails.** Verified directly: replaying a nonexistent member ID, the not-found banner is caught at the search-submit step and returned as `MEMBER_NOT_FOUND` before the engine evaluates the postcondition that would also technically hold, and before it attempts a next step that doesn't exist on that page.

**The result contract has four arms, not three**, because escalation is asynchronous — `needs_human` carries a `runId` precisely because it isn't terminal.

**Compile-time uniqueness is enforced live, not asserted.** The compiler replays a discovery trace against a real page through the same `resolveTarget()` the replay engine uses; a target is written into the artifact only after it resolves to exactly one match.

Real defects caught by reading raw evidence rather than trusting a green result, each fixed at the root:

- **`launchServer`+`connect` isolation** (§1) — would have silently broken the whole handoff mechanism if not caught before building on it.
- **Re-grounding checked a postcondition exactly once.** An operator's action can trigger a redirect or iframe reload still settling when resume fires; fixed with the same bounded `waitForCondition` every other postcondition uses.
- **A goal string leaked a raw sensitive value.** "Look up member 12345…" echoed back through the model's own `finish()` output. Fixed with a pre-flight guard refusing to launch if a goal contains a raw value verbatim, plus redaction at every terminal result, not only the trace.
- **A vision-channel leak the placeholder mechanism cannot close.** Even after that fix, the model still read a member's ID off a screenshot — the app's own page renders it back, same as a human operator would see. `{{inputs.NAME}}` protects the control plane (nothing *we* construct ever carries the raw value); it cannot stop a vision-capable agent from seeing what the app itself renders. Accepted, documented, mitigated by output-boundary redaction — not assumed away.
- **The compiled artifact had no postconditions**, and failed its own verification replay as a direct result. Fixed with a heuristic sound for any linear trace: every click step's postcondition is that the next step's target becomes visible.
- **`risky_irreversible` under `ATTENDED` mode**, caught by my own test asserting the wrong behavior: attended means a human can intervene, not that this action was pre-approved. Now returns `require_human` regardless of mode.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `SurfaceAdapter`'s methods are the only things that know what a browser is. `ObservedControl`'s `{role, accessibleName, framePath}` shape is exactly what a desktop UIA tree already exposes, so ladder rungs 2–3 port unchanged; rung 5 becomes a control-tree traversal instead of a DOM table walk; the last rung has no desktop analogue, flagged rather than glossed over.

**Multi-tenant reuse — built and verified, not just designed.** The capability belongs to the vendor product, never a tenant — `tenantId` appears nowhere in `CapabilityDefinitionSchema`, by construction. `TenantBinding` carries only specialization (entry URL, auth ref, `targetOverrides` keyed by `semanticPurpose`, feature flags — never credentials); `resolveCapability(base, binding)` is a pure function that replaces a purpose's candidates outright (no field-by-field merge that could leave a stale base candidate silently coexisting with an override) and swaps `scope.allowedOrigins` to the binding's `entryUrl`, leaving steps, checkpoint, and every non-overridden target untouched — asserted directly in tests, not just claimed. Demonstrated live: the same `member.read-savings-balance@2` artifact, recorded and verified against tenant A, replayed successfully against tenant B — a differently-labeled instance of the same vendor product ("Customer Number" for "Member ID", "Products" for "Accounts") on a different port — via the binding alone, no re-recording. The precedence chain lands in `RunState.resolvedFrom` for audit.

**Drift detection already has two signals in the schema.** `recordedRung` — a shift from rung 1 to rung 3 on a later replay is a leading indicator that fires before a capability breaks outright. `provenance.appFingerprint` (hash of the sorted `(role, name)` set at checkpoint, populated in both artifacts in this repo) is the coarser, whole-capability version.

## 5. Escalation & handoff

**Detection.** Three triggers: a policy `require_human`, an unresolvable target/postcondition on an `onBlock: escalate` step, and a declared interstitial handled `escalate`. Member `33333`'s notice is deliberately *not* auto-recoverable, distinct from `44444`'s visually similar but dismissable one — proving the system distinguishes "recoverable automatically" from "needs a human," not always guessing or always stopping.

**Ownership is a real state machine, tracked separately from run status.** `ControlOwner` and `RunStatus` are two axes — `NONE` is the real state between automation releasing and an operator claiming, and what a crash or expired lease leaves behind. Verified end to end: `AUTOMATION → NONE → HUMAN → NONE → AUTOMATION`.

**Take control is genuinely the same live session**, because the browser is out-of-process over real CDP (§1). The operator console is a second, independent process that attaches via `connectOverCDP`, sees the identical suspended page, and acts on it directly — confirmed by reading the before/after screenshots its own click produced.

**The console is deliberately bare** — server-rendered HTML, no framework, per the brief's own scope note. What's real is the mechanism: viewing claims the intervention; a quick-action button clicks a real registered control on the live session; Resume, with a required note, flips one field the suspended worker is polling for.

**Resume never assumes position — it re-derives it**, and deliberately does not re-attempt the step's action: the human's job was to clear the condition directly, not approve a retry — critical for `risky_irreversible`, where auto-retry risks double-submission. A resume that fixed nothing surfaces as a failure rather than looping into a second escalation.

**Audit.** Every human action is a `HUMAN_ACTION` event in the same `events.jsonl` automation writes to; the note lands in `RunState.operatorNotes`.

## 6. Safety

**Enforcement is structural.** Replay, discovery, and the engine's own interstitial recovery all route through `perform()` (or its discovery equivalents), which checks policy before touching the page. No second door.

**A click's own resulting navigation is re-checked against the allowlist** — a form submit was never itself a `navigate` step and so was never checked as one; if the URL changes after a click, the new route is checked too. This is the concrete form of the injection-containment argument: a hijacked or redirecting control can't walk a run out of scope, because policy sits below anything a page — or injected text inside it — could produce, and never reads page content to decide.

**`risky_irreversible` always requires an explicit, in-the-moment decision**, attended or not (§3) — attended means a human *can* intervene, not that this action *was* approved.

**Redaction happens at capture, never at write.** Sensitive controls are masked in the live DOM immediately before a screenshot; typed sensitive values cross from placeholder to real value only inside `perform()`, below logging. Discovery's terminal results are redacted before being persisted or returned, not only the trace.

**Known, accepted limit: the vision channel** (§3) — a screenshot-reading agent sees whatever the app renders back, same as a human would. Not preventable by the placeholder mechanism by construction; mitigated by redacting every output at the persistence boundary.

**Discovery-time containment is scope-based, not risk-classified** — raw discovery has no declared `riskClass` to check, so no mutating route is even reachable for a read-only goal, rather than trusting a real-time judgment the compiler hasn't made yet. A project-scope limit, not a general answer.

## 7. Cuts

Two stretch goals were built rather than left as design-only, since both turned out to be cheap given the schema decisions already made: **multi-tenant resolution** (§4 — `TenantBindingSchema`, `resolveCapability()`, a live cross-tenant replay against a differently-labeled variant) and the **capability catalog** (`src/catalog/index.ts` turns every verified artifact into a tool definition from the same Zod schema that validates it on disk; `npm run catalog:demo` shows Claude discovering and invoking `member.read-savings-balance@2` by name with typed arguments from a plain-language request). The catalog is additionally exposed over genuine MCP (`@modelcontextprotocol/sdk`, real `tools/list`/`tools/call` JSON-RPC over HTTP, `npm run mcp`) rather than only the Anthropic-SDK path — vendor-neutral discovery and invocation, verified with both a browser test UI and raw `curl`.

Deliberately still not built, and why:

- **Production session pooling, queues, multi-tenant plumbing** — not rewarded per the brief; `SessionBroker` is the right abstraction at N=1 (see `docs/phase-2-scale.md`).
- **`knownOutcomes`/`interstitials` are empty in the compiled artifact** — one happy-path run can't discover a dialog it never hit. A real pipeline merges multiple runs, or hand-authors these as v1 does.
- **`reauth` is a declared no-op** — referenced for schema completeness, no credential-refresh flow behind it.
- **A general compiler CLI** — `scripts/compile.ts` hardcodes this capability's output schema; the compilation logic itself takes it as a typed parameter and is fully generic.
- **Desktop adapter** — interface designed to accommodate one (§4), not implemented.
- **A version-variant layer between capability and tenant binding** — the three-layer model in §4 collapses to two in this build (base capability, tenant binding); a vendor-release variant layer is designed for but not exercised, since one vendor product version was in scope.

Next, in order: multi-run stability scoring on the existing verification harness; bounded single-step assisted repair (schema already reserves the field); a second tenant binding exercising the version-variant layer; production secrets/evidence-retention controls.
