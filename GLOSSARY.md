# Glossary

Terms as defined in the take-home brief, with a one-line pointer to where each one actually shows up in this repository — so the definition and the implementation stay checkable against each other, not just asserted side by side.

**Computer use** — an LLM operating a computer interface the way a person would, reading the screen or page and then clicking and typing, rather than calling an API.
*Here:* `src/discovery/loop.ts` — the observe → decide → act loop; every `evidence/discovery-*/` directory is a real transcript of this happening.

**DOM** — the browser's structured representation of a page. A "clean DOM" has meaningful elements and stable identifiers; legacy apps often don't.
*Here:* `target-app/templates.ts` is deliberately the opposite of clean — table layout, no test IDs, no ARIA — on purpose, per its own header comment.

**Accessibility tree** — the parallel representation browsers and operating systems expose for screen readers. Often more stable than raw markup, and available on desktop apps too.
*Here:* `ObservedControl`'s `{role, accessibleName, framePath}` shape (`src/discovery/setOfMarks.ts`) is built from this tree, not raw DOM structure — chosen specifically because the same shape describes a desktop UIA element (`COMPLIANCE.md` §3.7).

**Locator / selector** — how you tell automation which control to act on. The choice determines whether replay still works next month.
*Here:* `Target.candidates[]` (`src/contracts/target.ts`) — an ordered, typed list of strategies per control, each with a declared `rationale` and `confidence`, not a single selector string. `REPORT.md` §2/§3 and `ARCHITECTURAL_DECISIONS.md` §6 argue the choice in depth.

**Test ID** — an attribute developers add specifically so automation can find an element reliably. Legacy enterprise apps essentially never have them.
*Here:* rung 1 of the targeting ladder (`semantic_id`) is exactly this, and the target app deliberately has none — forcing every real replay in this project through the weaker rungs (`role_and_name`, `associated_label`) instead, live-verified rather than assumed.

**Deterministic replay** — re-running a recorded flow the same way every time, with no model deciding anything. Same inputs, same steps, same outputs.
*Here:* `src/replay/engine.ts` imports no LLM client at all; `tests/replay/no-llm-import.test.ts` asserts this structurally, and every `npm run replay` prints `llmCalls=0` because there is no code path that could make it anything else.

**Checkpoint** — a condition you assert to confirm you actually reached the state you expected, rather than assuming the click worked.
*Here:* `CapabilityDefinition.checkpoint`, required on every artifact; `run()` only returns `success` after it holds. `scripts/stability.ts` separately confirms it holds consistently across repeated runs.

**Business outcome vs. failure** — "no such member" is a legitimate answer the caller needs, not a crash. Conflating the two is the most common design mistake here.
*Here:* the four-arm `ExecutionResult` (`success` / `business_outcome` / `needs_human` / `failure`) and `knownOutcomes`, checked *before* postconditions at every step boundary — `REPORT.md` §3 verifies this ordering directly, not just by design.

**Tenant** — one customer institution. Hundreds of them, many running the same vendor software configured differently.
*Here:* `tenantId` appears nowhere in `CapabilityDefinitionSchema`, by construction — a `TenantBinding` carries only per-tenant specialization. Demonstrated live, not just designed: the same verified artifact replayed against a second, differently-labeled tenant instance with no re-recording (`docs/slices.md` Slice 8, `tenants/credit-union-b.json`).
