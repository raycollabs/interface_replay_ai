# Requirements Compliance — interface_replay_ai

This document maps every must-have requirement in the take-home brief (§3.1–3.7) to what was actually built, where it was reviewed line-by-line against the brief's exact wording, what gaps that review found, and how each was closed — with commit references and live evidence, not self-assessment. It complements `REPORT.md` (the brief's own requested 1–3 page design write-up) rather than replacing it; where a claim needs the full architectural reasoning, this document points at the relevant `REPORT.md` section instead of repeating it.

Every requirement below went through the same process: read the brief's exact bullet points, check the actual code and a live run against each one, and — where a gap was found — close it, re-verify live, and record the fix. Nine review passes (3.1 through 3.6, this document for 3.7) surfaced fourteen real gaps across the six executable requirements; all fourteen are closed, live-verified, and committed. The commit hashes below are on `main` at `raycollabs/interface_replay_ai` and can be read directly for the full reasoning and evidence behind each fix.

---

## 3.1 — Goal-driven agent loop

| Ask | Status | Evidence |
|---|---|---|
| Accept a goal + a target (app/URL/entry point) as input | ✅ Fixed | `--target-url`/`--entry-route` are genuine CLI flags; `DiscoveryOptions.entryRoute` is a required field `runDiscovery()` navigates to explicitly. **Gap found on review**: the target was originally only an env var (no CLI flag existed) and the entry point was implicit in the login helper's hardcoded post-login wait — neither was a real, caller-settable input. Closed in `b20c956`. |
| Run a real observe → decide → act loop against a live surface until the goal is met or a stopping condition hits | ✅ | `src/discovery/loop.ts`: set-of-marks grounding (`observeWithMarks`), a genuine Claude tool-use loop (`DiscoveryModel.decide`), real Playwright actions via `performDiscoveryClick/Navigate/Type/Extract`. Stopping conditions: max steps, wall-clock timeout, repeated-state detection, model-initiated `finish`/`request_human`, policy denial — five distinct conditions, not just a step counter. |
| Actually interact with a real UI; bias toward an approach that still works with no clean DOM | ✅ | Grounding is accessible-role/name based (`ObservedControl {role, accessibleName, tag, framePath}`), not DOM-structure based — the same shape a desktop accessibility tree already exposes (see §3.7 below). Verified live against markup with no ARIA and no `<label for>` associations (the target app's own legacy table-form style). |

---

## 3.2 — Structured artifact

| Ask | Status | Evidence |
|---|---|---|
| Ordered steps/actions | ✅ | `CapabilityStep[]` — action, target, value, pre/postcondition, risk class, `onBlock`, timeout, all typed. |
| How each target is identified, with reasoning about robustness | ✅ | Every `Target` carries an ordered `candidates[]` list, each with a typed `strategy`, a free-text `rationale`, and a `confidence` (`high`/`medium`/`low`) — not a bare selector. Full treatment of the design behind this in §3.7 below. |
| Typed input parameters | ✅ | `InputDef` — type, required, `sensitive` (drives redaction), `pattern`, `example`. |
| Typed outputs and their **shape** | ✅ Fixed | `OutputShape` is recursive (`scalar \| {object, properties} \| {array, items}`) — a capability can declare `account: {balance, currency, accountId}` as one structured output. **Gap found on review**: shape was originally a flat type tag (`'string'\|'number'\|...`), one field per fact, no way to express composition. Closed in `b6d92af`. Array shapes are declarable but not yet replay-producible — disclosed as an explicit cut, not hidden (`assembleOutput()` throws a named error rather than emitting an empty array). |
| A checkpoint / success condition | ✅ | `checkpoint: Condition`, required on every artifact — a capability without one cannot prove it reached the state it claims. |
| Versioned and reviewable | ✅ | `version: number`, `status: draft\|verified\|approved\|deprecated\|disabled`; every field carries a human-readable `intent`/`rationale`/`description` a reviewer reads directly, not a step index. |
| Emit the artifact after a successful run | ✅ Fixed | `npm run discover -- --auto-compile ...` compiles a successful discovery run into a draft artifact in the same command. **Gap found on review**: `compile` always existed but was a separate, easy-to-forget manual step — nothing made emission a consequence of success. Closed in `b6d92af`. Verification and promotion deliberately stay manual (auto-compile does not auto-verify or auto-promote). |

---

## 3.3 — Deterministic replay

| Ask | Status | Evidence |
|---|---|---|
| Replay an artifact + inputs with no LLM in the decision loop | ✅ | `src/replay/engine.ts` imports no LLM client; `tests/replay/no-llm-import.test.ts` asserts this structurally, not just by convention. CLI prints `llmCalls=0`. |
| Stable targeting, checkpoint verification, declared outputs returned | ✅ | Same `resolveTarget()` ladder as compile-time; `run()` only returns `success` after the checkpoint holds; outputs assembled via `assembleOutput()` per declared shape. |
| Detect and respond deliberately to: validation error, record-not-found, permission denial, unexpected dialog, session timeout, slow/failed load | ✅ Fixed | All six now have live fixtures and pass/fail correctly. **Gap found on review**: three of the brief's own six named conditions (validation error, permission denial, session timeout) were declared vocabulary (`semanticPurposes.ts`, `FailureCodeSchema`) with zero fixtures or code paths ever exercising them — the exact "record not found" mistake the brief itself warns about, just relocated to three sibling conditions. Closed in `ad108dd` with three new target-app scenarios and a new `sessionLoss` schema field; live-verified with two real targeting bugs found and fixed along the way (see commit). |
| Distinguish business outcomes / recoverable conditions / hard failures in the result contract | ✅ | Four-arm `ExecutionResult` (`success`/`business_outcome`/`needs_human`/`failure`); business-outcome probes checked *before* postconditions at every step boundary so a legitimate result is never misread as a broken step. |

---

## 3.4 — Safety & policy guardrails

| Ask | Status | Evidence |
|---|---|---|
| Explicit, configurable allowlist (domains/routes/action types) | ✅ | `evaluatePolicy()` checks all three, sourced from the artifact's own declared `scope`, intersected with a tenant allowlist for cross-tenant use (`intersectWithCapabilityScope`) — a capability's scope is a ceiling even the tenant can't widen. |
| Agent cannot act outside it | ✅ | `evaluatePolicy()` runs inside the single `SurfaceAdapter.perform()` choke point — no other path from either engine to the live page. A click's own resulting navigation is re-checked too. |
| Distinguish safe/reversible from risky/irreversible; handle the risky class conservatively, justified | ✅ Fixed | `risky_irreversible` always forces `require_human`, in both `ATTENDED` and `UNATTENDED` mode; `mutating_reversible` is gated by an `unattendedRiskCeiling` only when unattended. **Gap found on review**: the design was real but every capability in the repo declared every step `read_only` — the two higher risk classes were only ever exercised by calling `evaluatePolicy()` directly in a unit test. Closed in `ba9fa00` with two new real capabilities (`member.create-sub-account`, `member.close-sub-account`), live-verified in both modes, one carried through a full human-approval cycle on the real operator console with a genuine account deletion. |
| Never persist secrets/tokens/full PII into artifacts or logs; redact appropriately | ✅ Fixed | Sensitive input values are masked in the live DOM before every screenshot and substituted below the logging boundary for every typed value. **Gap found on review**: masking only covered `<input>` elements — a value the app echoed back as plain page text (a "no such member 99999" banner) was confirmed, by pulling the actual persisted screenshot, to be baked unredacted into the pixels. Closed in the same `ba9fa00` commit with a DOM text-node sweep across every frame immediately before capture. |

---

## 3.5 — Evidence / observability

| Ask | Status | Evidence |
|---|---|---|
| A structured log of what the agent did and why | ✅ Fixed | `events.jsonl` (`RunEvent` stream, redacted before write) — `ACTION_STARTED` now carries the step's own declared `intent`; `RECOVERY_ATTEMPTED` names which interstitial fired; `BUSINESS_OUTCOME_DETECTED` carries both `code` and human-readable `message`. **Gap found on review**: `intent` was never logged at all, and three of five places the engine returns a business outcome never emitted the event that names it. Closed in `ec6cd73`, consolidated into one `returnBusinessOutcome()` method so the gap can't recur at a sixth site later. |
| At least one richer signal on failure | ✅ Fixed | A screenshot on every terminal path (`success`/`business-outcome`/`failure`/`session-lost`/`needs-human`). **Gap found on review**: `ESCALATION_UNAVAILABLE` (a resume timing out) had zero fresh evidence — only the screenshot from whenever escalation was *first* requested, potentially stale by the time a timeout fires. Closed in the same commit with a dedicated screenshot at the moment of that specific failure. |

---

## 3.6 — Human-in-the-loop escalation & handoff

| Ask | Status | Evidence |
|---|---|---|
| Detect and route a stuck/blocked state, carrying capability/goal, current step, current state/screenshot, and why it stopped | ✅ Fixed | `InterventionRequest` carries all of it (`capabilityId`/`goal`, `stepId`, `screenshotRef`, `reasonCode` + `explanation`). **Gap found on review**: this was fully real for replay but discovery's own "stuck" paths (`TIMEOUT`, `REPEATED_STATE`, `MAX_STEPS`, the model's own `request_human()`) just wrote a JSON summary and closed the browser — structurally impossible to hand off, not merely unimplemented, since the live session was already gone. Closed in `c5f9f77` with `escalateDiscovery()`, reusing replay's exact intervention mechanism. |
| Let a human operate the *same* live session, then hand control back so the run resumes or completes; preserve context/evidence; record what the human did | ✅ | Real out-of-process CDP session sharing (`connectOverCDP`), proven via before/after screenshots the operator's own click produced. `HUMAN_ACTION` events + `operatorNotes`/trace entries record what happened. The operator console's new `/act-by-text` endpoint (added while closing the discovery gap) lets a human act even with no capability artifact loaded yet — verified against both a live discovery session and a known replay control. |
| A seam to pause, cede, resume on the same session; a way to know who is/should be in control | ✅ | `ControlOwner` (`AUTOMATION`/`HUMAN`/`NONE`) tracked as an axis separate from run status; `NONE` is the real transitional/crash state. Verified end to end, repeatedly: `AUTOMATION → NONE → HUMAN → NONE → AUTOMATION`, including four consecutive cycles on one discovery run that then completed its original goal for real. |

---

## 3.7 — Design for heterogeneity & scale

This requirement's deliverable *is* the write-up — nothing below was meant to be built, and nothing was, beyond what already exists as a side effect of the requirements above. The two questions the brief asks are answered in full below rather than as a table, per an explicit request to go deeper than a status row here; a short summary table is included first for consistency with the rest of this document.

| Ask | Status | Where it lives |
|---|---|---|
| Surface abstraction: extend from the chosen surface (web) to a legacy web app and/or desktop app; identify the perceive/act ↔ recorded-flow seam | ✅ Designed, partially built | This section; `REPORT.md` §4; `src/surface/`, `src/contracts/target.ts` |
| Multi-tenant reuse across hundreds of tenants sharing a vendor product; drift detection | ✅ Designed, built and live-demonstrated at N=2 tenants | This section; `REPORT.md` §4; `docs/phase-2-scale.md`; `src/multitenant/resolve.ts`; live cross-tenant replay in `docs/slices.md` Slice 8 |

### Surface abstraction

**The seam, stated precisely.** Nothing in a `CapabilityStep` or a `Condition` ever names a surface technology. A step says `targetPurpose: "account balance field"` and an action type (`click`/`type`/`extract`/…); a condition says `{type: 'controlVisible', semanticPurpose: '...'}`. The *only* place surface-specific knowledge exists is `targetRegistry` — a map from `semanticPurpose` to a `Target`, which is itself an ordered list of typed `candidates`, each a `{strategy, rationale, confidence}` triple — plus the one class, `SurfaceAdapter`, that turns a resolved candidate into a real action. That is the seam: **"how we perceive/act on a surface" is entirely contained in `targetRegistry` + `SurfaceAdapter`; "the recorded flow" (`steps[]`, `checkpoint`, `knownOutcomes`, `interstitials`) speaks only in `semanticPurpose` and never crosses that line.** A new surface means a new `SurfaceAdapter` implementation and a new way of populating `targetRegistry`; it means zero changes to the step sequence, the checkpoint, or any artifact already compiled against a different surface for the same logical flow.

This is not a novel insight invented for this project. Independently arriving at the same seam and then checking it against how mature RPA platforms solve the identical problem is a useful sanity check, and it holds up well: Pega Robot Studio's "interrogation" process creates a persistent, technology-neutral `Control` and a separate runtime `Target`, connected by match rules, specifically so the same logical control survives across Windows/Java/HTML implementations. Blue Prism's Application Model is fed by multiple interchangeable "spy" technologies (Win32, UI Automation, Accessibility, Java, HTML/Chromium, Region, Smart Vision) into one logical model. Microsoft's own UI Automation framework separates *control type* (what it is) from *control pattern* (what it can do) for exactly this reason. UiPath's "Unified Target" layers strict selectors, fuzzy selectors, anchors, and computer vision behind one logical target. Four independently-built commercial platforms converging on the same abstraction — a technology-neutral logical control resolved by an ordered set of surface-specific strategies — is a strong signal that `targetRegistry`'s shape is the right one, not an idiosyncratic choice.

There is an older, more specific lineage for this too, worth naming directly: enterprise trade-and-risk (CTRM) automation work with source-code access to the target application, where the natural model was a strict object hierarchy — `Application → View → Pane → Grid → Row → Cell → Control`, each with its own mapped set of supported actions. That hierarchy is the direct ancestor of `structural_semantic` targeting here (a control identified by `{rowHeader, columnHeader}`, e.g. `{rowHeader: "Savings", columnHeader: "Balance"}`) and of `framePath` (the `View`/`Pane` layer, made literal as an iframe path). The difference this project had to solve, and the harder version of the same problem, is reconstructing that kind of semantic structure **without** source access — from whatever the surface exposes at runtime (DOM, accessibility tree, screenshot) instead of from a schema the target's own authors handed over. `targetRegistry`'s `candidates[]` — an ordered, typed, ranked set of ways to re-derive the same logical control — is the answer this project settled on for that harder version, and it is a leaner, schema-first version of exactly the multi-provider model Blue Prism and Pega converged on independently.

**What is already built, concretely.** Six strategy types exist today (`src/contracts/target.ts`), each a distinct typed shape, not a generic `{key: value}` bag:

| Rung | Strategy | Desktop-portable? |
|---|---|---|
| 1 | `semantic_id` (a stable DOM id) | Yes — an `automationId` lookup |
| 2 | `role_and_name` (accessible role + name) | Yes — `(ControlType, Name)` on a UIA element, unchanged |
| 3 | `associated_label` (a real `<label>`, or the legacy table-cell-adjacency heuristic) | Yes — a named-property lookup either way |
| 5 | `structural_semantic` (a `{rowHeader, columnHeader}` pair in a table) | Conceptually yes — a `Grid`/`Table` UIA control pattern traversal instead of an HTML `<table>` walk; no desktop analogue *as written*, but the same *idea* |
| 6 | `text_anchor` (relative to a stable text anchor: same-row, next-sibling, first-input-below) | Partially — the anchor concept ports, the DOM-specific relationship types would need desktop equivalents |
| 7 | `visible_text` (raw text match, last resort) | No — explicitly flagged `nonPortable` in the schema's own comment, would be OCR/visual-anchor territory on a source-blind or Citrix-style surface |

Every candidate already carries a `rationale` (why this strategy is believed robust for this control) and a `confidence` (`high`/`medium`/`low`) — this is not a proposed enhancement, it is what every artifact in this repo already contains. A real example, from `capabilities/member.read-savings-balance.v1.json`:

```json
{
  "strategy": { "type": "associated_label", "label": "Member ID" },
  "rationale": "Actual markup: the label is an adjacent <td> with no for/aria association, a legacy table-form pattern. Resolved via the adapter's nearest-preceding-cell-in-row heuristic, not Playwright's built-in label matching (which requires a real <label> element). Rung 2 (role_and_name) genuinely fails to resolve against this control -- this fallback firing on every real replay is expected, not a decorative fallback.",
  "confidence": "high"
}
```

This directly answers the brief's own phrasing — "how each target element/control is identified (with your reasoning about robustness)" — as a structural property of the schema, reviewable by a human before the capability is ever promoted, not as prose bolted on afterward.

The resolver (`resolveTarget()`) tries candidates *in declared order* and stops at the first strategy that resolves to **exactly one** match; more than one match is reported as `ambiguous` immediately, never silently resolved by falling through to a weaker strategy. This is a deliberate rejection of a confidence-*scored* resolver (candidates ranked by a weighted score, accepted above a tunable minimum-confidence and uniqueness-delta threshold) — a design worth naming because it is how several commercial tools (UiPath's Computer-Vision-assisted matching among them) actually work, and it was considered and rejected here. A scored resolver reintroduces exactly the class of non-deterministic, retunable judgment call this system's replay path exists to eliminate: a 0.91-vs-0.89 confidence gap silently deciding which control got clicked is the same failure shape as a similarity-search deciding which capability to run (see `docs/phase-2-scale.md`'s identical argument for capability *selection*), just moved one layer down to control *selection*. An ordered, boolean-outcome ladder is slower to author (someone has to declare the fallback order explicitly) but produces a system whose behavior at replay time is fully determined by the artifact file on disk — auditable, and stable across a threshold-tuning change nobody remembers making. For a money-moving capability in a regulated environment, that trade is the right one.

**Extending to a legacy web app.** This is not hypothetical for this project — it is the environment already built and stress-tested throughout. `target-app/templates.ts` is deliberately old-school server-rendered HTML: table-based layout, no test IDs, no ARIA, form labels associated only by table-cell adjacency, exactly the "old/ugly browser application" case. The `associated_label` rung's fallback heuristic (find a `<td>`/`<th>` whose text matches the label, then the first form control in a *later* cell of the same `<tr>`) is precisely the "anchor text, adjacent input" pattern a frameset-era app needs, and it has been the load-bearing rung for the member-identifier field in every live replay this session, not a rung that exists on paper and never fires.

**Extending to a desktop app.** `ObservedControl`'s shape — `{role, accessibleName, tag, framePath}` — was chosen because it *is* what a Windows UIA element or a macOS accessibility element already looks like: `(ControlType, Name)` plus a window/pane hierarchy. Concretely, porting means:

- A new `SurfaceAdapter` (e.g. `UiaSurfaceAdapter`) implementing the same `perform()` contract, translating `click` → `InvokePattern.Invoke()`, `type` → `ValuePattern.SetValue()` (preferred over synthesized keystrokes where the pattern is available — more stable, and closer to how a real UIA-based tool operates), `extract` → reading the element's `Name`/`Value` property.
- Rungs 2–3 (`role_and_name`, `associated_label`) need no schema change at all — a `(ControlType, Name)` lookup is a `role_and_name` lookup by another name.
- Rung 5 (`structural_semantic`) becomes a `Grid`/`Table` UIA pattern traversal instead of an HTML `<table>` walk — same concept (row/column header identifies the cell), different tree to walk.
- Rung 7 (`visible_text`) has no real desktop equivalent and is already flagged as such; a genuinely source-blind or Citrix/RDP-style surface (no accessibility tree exposed at all) would need a new, honestly-named eighth rung backed by OCR and visual anchors — the same territory Automation Anywhere's AISense and Blue Prism's Smart Vision occupy for exactly this case. This project does not build that rung, and says so rather than pretending the existing ladder silently covers it.
- `framePath` generalizes to a window/pane path; `resolveFrame()`'s walk-down-by-name logic is unchanged in shape.

No field on `Target`, `CapabilityStep`, or `Condition` would need to change to support this. That is the concrete meaning of "the core abstractions not being painted into a corner" for this half of 3.7.

**Two concrete, low-cost additions this design would make before a second surface is actually built** (named here as the credible next increment, not built, per the requirement's own framing): (1) a `rejectedStrategies` field alongside `candidates[]`, recording strategies that were considered and specifically rejected with a reason (e.g. "absolute DOM position — sensitive to inserted rows") — cheap, and it answers "why not X" with the same rigor the schema already gives to "why X"; (2) naming the per-surface *default ladder order* as an explicit, documented table (as above) rather than leaving it to be re-derived per capability author, so a web capability and a desktop capability compiled from the same discovery goal make the same rung-ordering decisions by convention, not by accident.

### Multi-tenant reuse

**The mechanism, already in the schema, not just the docs.** `tenantId` appears nowhere in `CapabilityDefinitionSchema` — checkable directly by reading the schema file, not a claim to take on faith. A `CapabilityDefinition` belongs to the vendor product; a separate `TenantBinding` (`src/contracts/tenantBinding.ts`) carries only specialization: `entryUrl`, `authProfileRef` (a *reference*, never a credential — enforced by the same redaction discipline as everything else in this system), and `targetOverrides` keyed by `semanticPurpose` — the identical key `targetRegistry` uses. `resolveCapability(base, binding)` (`src/multitenant/resolve.ts`) is a pure function: it replaces a purpose's candidate list outright (no field-by-field merge that could leave a stale base candidate silently coexisting with an override), swaps `scope.allowedOrigins` to the binding's `entryUrl`, and leaves every step, the checkpoint, and every non-overridden target byte-for-byte untouched. The precedence chain is recorded in `RunState.resolvedFrom` for audit, not just implied.

This is not a paper design. The same `member.read-savings-balance@2` artifact — recorded and verified against one tenant's app instance — was replayed successfully against a second, differently-labeled instance of the same underlying vendor product ("Customer Number" instead of "Member ID", "Products" instead of "Accounts", a different port) purely via a `TenantBinding`, with zero re-recording (`docs/slices.md`'s Slice 8 entry, `tenants/credit-union-b.json`). Two tenants is not "hundreds," but it is the mechanism proven at the smallest N where "does the abstraction actually hold" can be answered by more than argument.

**The governance rule that keeps "reuse" from becoming "silent drift."** A binding may *narrow or redirect* a target (a different label, a different route); the schema gives it no way to add a step, remove a step, or change the checkpoint. `targetOverrides`' type (`TargetSchema.omit({semanticPurpose: true})`) enforces this structurally, not by convention — a binding literally cannot express "and also click this extra button first." If a tenant genuinely needs different behavior, the honest answer is a new capability *version*, reviewed and versioned like any other change, not a binding that quietly diverges into an undocumented second flow that looks identical in the catalog. This is the concrete answer to "how would you represent an artifact so it can be reused **or safely specialized/overridden**" — the safety is in what the override mechanism is structurally incapable of expressing, not in a review process trusted to catch overreach after the fact.

**Drift detection — two signals, both already computed, neither hypothetical.** `recordedRung` is stored on every `Target` at compile time; a later replay resolving the same purpose through a *different, weaker* rung (rung 1 at compile, rung 3 at replay) is a leading indicator that the app changed, catchable before the capability breaks outright rather than after. `provenance.appFingerprint` — a hash of the sorted `(role, accessibleName)` set observed at the checkpoint — is the coarser, whole-capability version of the same idea, computed once at verify time and compared on every later replay; both fields are already populated in this repo's artifacts, not left as unused schema surface the way a few other fields were before this review (see 3.3/3.5 above). A production system would compare the fingerprint on a schedule (nightly, or before promoting a new tenant onto an existing capability) and flag `REVALIDATION_REQUIRED` rather than failing a live customer-facing run or silently re-discovering — the same "detect and route to a decision, don't guess" philosophy §3.6's escalation mechanism already embodies, applied to drift instead of a stuck run.

**What scales beyond the two layers actually built here.** `docs/phase-2-scale.md` lays out a third layer — `VersionVariant`, sitting between the base capability and a tenant binding, for differences introduced by a vendor's own product release (a new version of the underlying banking core, not a tenant's branding choice) — collapsed to two layers in this repo because only one vendor product version was ever in scope. That is not a corner painted into: `VersionVariant` would use the *exact same* `targetOverrides`-keyed-by-`semanticPurpose` mechanism `TenantBinding` already implements, just keyed by product version instead of tenant, layered as `CapabilityDefinition → VersionVariant → TenantBinding` with the same "override, never add a step" rule at each layer. Building it is one more instantiation of a pattern already proven, not a redesign.

Two further scale arguments from `docs/phase-2-scale.md`, condensed to their conclusions since the full reasoning lives there: capability **selection** stays a deterministic lookup (`tenantId, capabilityId, applicationInstanceId → exact immutable artifact version`) rather than an embedding/similarity search, for the identical reason a scored target-resolver was rejected above — selection nondeterminism defeats the entire point of deterministic execution, and intent-to-capability mapping belongs to the calling agent (which has the conversation and can ask a clarifying question), not to a matcher with less context and no way to ask one. And the scaling primitive across hundreds of tenants is a keyed session pool (`⟨tenant, app, authProfile⟩ → warm session`, with a human-held handoff correctly counted against that tenant's capacity), not a message queue — `SessionBroker` (`src/session/broker.ts`) is already that abstraction at N=1, and scaling it is a pooling and eviction problem, not a schema change.

---

*Live evidence for every claim above — screenshots, `events.jsonl` audit trails, and `result.json` outcomes — lives under `evidence/` in this repo, organized by scenario name. See `README.md`'s "Verify it yourself" section for the exact commands to reproduce any of it.*
