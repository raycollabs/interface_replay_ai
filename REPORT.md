# Design Report — interface_replay_ai

*Kept to the brief's ~1–3 page guidance. Every claim here has live evidence under `/evidence/`; the exhaustive requirement-by-requirement mapping and gap-closure history live in `COMPLIANCE.md` and `docs/slices.md` — this document is the argument, not the ledger.*

## 1. Architecture

The system is a compiler and runtime for UI-driven capabilities, not a browser-agent demo: an LLM discovers a flow once; a compiler turns the successful trace into a typed, versioned capability artifact; a deterministic runtime executes that artifact in production with zero LLM calls; a session broker hands control to a human when automation cannot safely proceed.

**Modular monolith**, one package, logical boundaries under `src/`: `contracts` (Zod — the single source of truth every other module types against), `surface` (adapter + targeting ladder), `policy` (allowlist + redaction), `replay` (the deterministic engine), `discovery` (the agent loop), `compiler` (trace → artifact), `session` (the handoff broker). No physical service boundaries — the brief is explicit that scaling infrastructure isn't rewarded; see `docs/phase-2-scale.md` for how this shape would scale without changing.

**`SurfaceAdapter` is the sole extensibility and enforcement seam.** `perform()` is the only method that touches the live page, and it calls `policy.evaluate()` internally before acting. Neither replay nor discovery has a path to the browser that skips this — the guardrail is structural, not conventional, which is what makes §6's injection-containment claim concrete.

**Replay is a suspendable state machine, not a blocking call**, because escalation makes it asynchronous — closing the browser while a human is still deciding would break the whole premise of a same-session handoff. `RunState` persists after every step boundary; `escalate()`/`regroundAfterResume()` are the one ownership-transfer path shared by every "can't safely proceed" site in the engine (and, after review, in discovery too — §5).

**Out-of-process browser via real CDP, not Playwright's own `launchServer()`+`connect()`.** Verified directly, before relying on it: a second `connect()` call to a `launchServer()` browser gets an isolated view with zero contexts — that pairing is for *sequential* reuse across test runs, the opposite of a same-session handoff. Chromium is launched with `--remote-debugging-port` exposed instead; both the replay worker and the operator console attach via `connectOverCDP()`, confirmed to genuinely share contexts across simultaneous clients.

**Artifact emission is automatic on a successful run.** `npm run discover -- --auto-compile` compiles the trace it just recorded straight into a draft artifact in the same command — the brief's "after a successful run, emit a typed artifact," done for real. It automates only that one step: verification and promotion stay manual, because "verified" means a human confirmed the capability generalizes, not that the compiler didn't crash.

## 2. Artifact schema

An API contract whose implementation happens through UI automation, not a step recording.

**`targetRegistry` is the single place every semantic purpose resolves to a strategy** — shared between step targets and every condition (checkpoint, outcomes, interstitials), and the tenant-override seam (§4).

**Conditions are structured discriminated unions, never strings** — `{type:'controlVisible', semanticPurpose:'account balance field'}`, not `"balance is showing"`. A string forces `eval`-style interpretation or an undocumented DSL and couples the schema to one surface; a structured condition compiles to a DOM query today and a UIA check tomorrow, unchanged.

**Every target carries typed strategies, ordered by preference, plus the frame it resolves in.** Rungs 2–3 (`role_and_name`, `associated_label`) port directly to a desktop accessibility API; the last rung (`visible_text`) doesn't, and the schema flags that rather than hiding it. Every candidate carries a `rationale` and a `confidence` — the artifact's own answer to "how each target is identified, with reasoning about robustness," not prose bolted on afterward.

**`knownOutcomes` are declared, not caught** — "no such member" is a named, typed result visible before invocation, the direct fix for the brief's own named most-common mistake.

**Output shape is a recursive type, not a flat tag**: `scalar | {type:'object', properties} | {type:'array', items}`, so a capability declares real nested structure (`account: {balance, currency, accountId}`) as one output. `OutputDefSchema`'s `superRefine` enforces a producer per shape — a scalar needs `sourceStepId`, an object needs `sourceStepsByProperty` naming every property; an array is representable but not yet replay-producible, and `assembleOutput()` throws a named error rather than guessing, which is the honest version of "the schema can describe more than the runtime fulfills yet."

**Scope is a ceiling, not a grant**: effective policy is `tenantAllowlist ∩ capability.scope`. **`assistedRepair`** is capability-level, off by default, capped at one step — per-step `onBlock` is only `escalate | fail`, so no enum value quietly reintroduces open-ended LLM control into the default path.

## 3. Determinism & error handling

**The targeting ladder tries candidates in order and stops at the first exactly-one match.** More than one match returns `ambiguous` immediately rather than falling through to a weaker strategy — ambiguity at replay means the app changed since compile, not something to guess past. (A confidence-*scored* resolver, as some commercial tools use, was considered and rejected: a numeric threshold silently deciding which control got clicked is no more auditable than a similarity score silently deciding which *capability* ran — the identical determinism argument `docs/phase-2-scale.md` makes against embedding-based capability selection, applied one layer down.)

**Business outcomes are checked before postconditions, at every step boundary** — verified directly: a nonexistent member ID is caught and returned as `MEMBER_NOT_FOUND` before the engine ever evaluates a postcondition that would also technically hold. **The result contract has four arms, not three**, because escalation is asynchronous — `needs_human` carries a `runId` because it isn't terminal.

**Every run produces a structured "what and why" log, plus a screenshot on every terminal path.** `events.jsonl` (`ACTION_STARTED`, `BUSINESS_OUTCOME_DETECTED`, the full handoff sequence, …) is redacted before write, never after; `ACTION_STARTED` carries the step's own declared `intent`, so the log explains itself without the artifact open alongside it. Discovery's own "why" is `modelRationale` in `trace.jsonl` — an operational summary, deliberately not full chain-of-thought.

**Compile-time uniqueness is enforced live, not asserted** — the compiler replays a trace through the same `resolveTarget()` replay uses, and writes a target only after confirming exactly one match.

Real defects caught by reading raw evidence rather than trusting a green result:

- `launchServer`+`connect` isolation (§1) — would have silently broken the handoff mechanism if not caught first.
- A goal string leaked a raw sensitive value through the model's own `finish()` output; fixed with a pre-flight guard plus terminal-result redaction, not just trace redaction. A related, accepted limit: a vision-capable model can still read a value the app itself renders back on screen — the placeholder mechanism protects the control plane, not the vision channel.
- Three of the brief's own named runtime conditions (permission denial, validation error, session timeout) were declared vocabulary with nothing behind them until reviewed — closed with real fixtures; the fix itself surfaced a second bug (two banners sharing one role-only selector resolved to whichever `knownOutcome` was checked first, and `role="alert"` doesn't derive its accessible name from text content per the ARIA spec, so a content-substring match silently resolved to nothing). Fixed with explicit `aria-label`s and exact matching.
- Three of five `business_outcome` return sites never emitted the event naming them, and a fourth omitted its human-readable message — found by grepping for every construction site, not trusting the one already fixed. Consolidated into one `returnBusinessOutcome()` method.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `ObservedControl`'s `{role, accessibleName, framePath}` shape is exactly what a desktop UIA tree already exposes, so ladder rungs 2–3 port unchanged; rung 5 (`structural_semantic`, row/column-header targeting) becomes a `Grid` pattern traversal instead of an HTML table walk — the same idea this project's own CTRM-automation lineage used with source access (`View → Pane → Grid → Row → Cell`), reconstructed here from the observable surface instead. This design was checked against, and holds up against, how Pega, Blue Prism, and UI Automation solve the identical problem (technology-neutral logical control, resolved by ranked strategies) — external validation, not the origin. The last rung (`visible_text`) has no desktop analogue and is flagged `nonPortable` rather than glossed over; a genuinely source-blind surface (Citrix) would need an honestly-named OCR/visual-anchor rung this project doesn't build. Full treatment in `COMPLIANCE.md` §3.7.

**Multi-tenant reuse — built and verified, not just designed.** `tenantId` appears nowhere in `CapabilityDefinitionSchema`, by construction. `TenantBinding` carries only specialization (entry URL, auth ref, `targetOverrides` keyed by `semanticPurpose`); `resolveCapability()` replaces a purpose's candidates outright, structurally incapable of adding a step or changing the checkpoint — if a tenant needs more, that's a new capability version, not a silently-diverging binding. Demonstrated live: the same artifact, recorded against tenant A, replayed successfully against tenant B's differently-labeled instance via the binding alone, no re-recording.

**Drift detection**, both already computed: `recordedRung` shifting between compile and replay is a leading indicator; `provenance.appFingerprint` (a hash of the checkpoint's `(role, name)` set) is the coarser, whole-capability version.

## 5. Escalation & handoff

**Detection — four triggers, not three, after review.** A policy `require_human`, an unresolvable target/postcondition, a declared `escalate` interstitial — and, closed on review, "the agent is stuck during discovery" (one of the brief's own three named cases). Discovery's stuck paths originally just wrote a summary and closed the browser, identically to a hard failure — structurally impossible to hand off, since the session was already gone. Closed by giving discovery the same `escalateDiscovery()` path replay's `escalate()` already uses, reusing the identical intervention/session-handle/`waitForResolution()` mechanism rather than a second implementation. One trigger stays deliberately unescalated: a containment-boundary failure (an out-of-allowlist route) has nothing on screen for a human to act on, and inviting one would undermine the boundary rather than honor it.

**Ownership is a state machine, tracked separately from run status.** `ControlOwner` (`AUTOMATION`/`HUMAN`/`NONE`) — `NONE` is the real state between release and claim. Verified end to end, repeatedly, including four consecutive suspend/resume cycles on one discovery run that then completed its original goal for real.

**Take control is genuinely the same live session** (real CDP, §1) — the operator console is a second, independent process, confirmed via before/after screenshots its own click produced. Extended for discovery, which has no capability (and no `targetRegistry`) yet: a new `/act-by-text` endpoint clicks by raw visible text — the same last-resort mechanism the ladder's own `visible_text` rung uses — verified against both a live discovery session and a known replay control.

**Resume re-derives position; it never re-attempts the action** — the human's job was to clear the condition, not approve a retry, which matters most for `risky_irreversible` (auto-retry risks double-submission). Every human action lands as a `HUMAN_ACTION` event and an operator note, on both sides of the compile boundary.

## 6. Safety

**Enforcement is structural** — replay, discovery, and interstitial recovery all route through one `perform()` choke point; a click's own resulting navigation is re-checked against the allowlist too, which is the concrete form of the injection-containment argument.

**`risky_irreversible` always requires an explicit decision, in both modes** — originally proven only by a unit test; closed for real with two capabilities exercising the two non-`read_only` risk classes end to end, one carried through a full human-approval cycle to a genuine account deletion.

**Redaction happens at capture, never at write** — sensitive values are masked in the live DOM before a screenshot and substituted below the logging boundary. Extended after a real leak was found, not assumed complete: masking covered `<input>` elements only; a value the app echoed back as plain text was confirmed, by pulling an actual screenshot, baked unredacted into the pixels. Fixed with a DOM text-node sweep across every frame immediately before capture.

**Known, accepted limits, stated rather than hidden**: a vision-capable model can still read a value the app renders back on screen (§3); a target strategy can't be parameterized by a runtime input value, so `member.close-sub-account`'s generic selector is correct only because the demo scopes to one account per member; discovery's own containment is scope-based, not risk-classified, since raw discovery has no declared `riskClass` yet.

## 7. Cuts

Built rather than left as design-only, since each was cheap given decisions already made: multi-tenant resolution with a live cross-tenant replay; a capability catalog exposed over genuine MCP (`tools/list`/`tools/call`), not just the Anthropic SDK; route canonicalization (which caught two real defects — a policy matcher that didn't understand `:name` segments, and a checkpoint proposal that outlived the page state it came from); multi-run stability checking (5/5, zero rung drift).

Deliberately not built, and why: **production session pooling/queues/multi-tenant plumbing** (not rewarded per the brief; `SessionBroker` is the right abstraction at N=1); **empty `knownOutcomes`/`interstitials` in a compiled artifact** (one happy-path run can't discover a dialog it never hit — a real pipeline merges multiple runs); **array output shapes with no replay producer** (declarable, not yet assembled); **`reauth`** (a declared no-op, no credential-refresh flow behind it); **a desktop adapter** (interface designed to accommodate one, §4, not implemented); **a version-variant layer** between capability and tenant binding (collapses to two layers here since one vendor product version was in scope; it would reuse `TenantBinding`'s exact override mechanism, not need a redesign).

Next, in order: bounded single-step assisted repair (schema already reserves the field); a second tenant binding exercising the version-variant layer; production secrets/evidence-retention controls.
