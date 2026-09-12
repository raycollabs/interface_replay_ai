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

- [x] **Slice 3 — Replay engine + run state. The walking skeleton.** The
  hardcoded array becomes artifact-driven (`ReplayRun` in
  `src/replay/engine.ts`). Step loop, precondition/postcondition waits (no
  unconditional sleeps anywhere), checkpoint verification, output
  extraction, the four-arm result, durable run state written after every
  step, a structural `no-llm-import` test (scans `src/replay`,
  `src/surface`, `src/policy` for any LLM-client import — fails the
  moment one is added later, on purpose or by accident, not just a
  runtime assertion). Also added: runtime input validation against the
  declared schema (required + pattern) before anything touches the
  surface — a real gap in the original plan, caught while wiring the CLI.
  Gate (`npm run replay -- --capability member.read-savings-balance --version 1 --input memberId=12345 --evidence-dir evidence/replay-success`):
  returns `{status:"success", outputs:{accountId,balance,currency}}`.
  Evidence directory contains `run-state.json`, `events.jsonl`,
  `result.json`, `success.png` — confirmed by grep that the raw
  `memberId` value appears in NONE of them (redaction-at-capture,
  verified, not just asserted).
  **End of this slice = a complete vertical thread through every
  production layer, with no LLM in the repo.**

  Scope pulled forward from Slice 4 (the mechanism was already there once
  the engine existed, so proving it cost nothing extra): the same run
  also produced `evidence/replay-business-outcome/` (memberId=99999 ->
  `MEMBER_NOT_FOUND`, detected at the `submit-search` step boundary
  *before* its postcondition would otherwise have been evaluated — the
  ordering that keeps a legitimate business result from being
  misclassified as a broken step) and `evidence/replay-failure/`
  (memberId=`abc` -> `INPUT_CONTRACT_VIOLATION`, rejected pre-flight
  against the declared `^[0-9]{5}$` pattern). Three of the four
  `ExecutionResult` arms demonstrated with real evidence by the end of
  Slice 3; `needs_human` follows in Slice 5, once there's a human to hand
  off to.

- [x] **Slice 4 — Recoverable conditions.** Added two member-scoped
  fixtures to the target app: `44444` shows an unexpected "notice" dialog
  once per session (withholds the real accounts page until a `<button>
  Continue</button>` is clicked); `55555`'s accounts-frame iframe serves
  a `role="status"` loading placeholder on the first request per session
  and the real table from the second request on. Two new interstitials
  declared on the capability (`unknown dialog dismiss` -> `dismiss`,
  `account data loading banner` -> `retry`), each with real
  `targetRegistry` entries, not placeholders.

  Two design fixes surfaced while wiring this up, both closing real gaps
  rather than working around them:
  - `handleInterstitial`'s dismiss/retry actions were going to route
    straight through Playwright (`page.keyboard.press`, `page.reload`),
    bypassing the policy check every other action goes through. Fixed by
    routing both through `adapter.perform()` as synthetic steps — the
    engine's own recovery logic gets no exception to "no path to the
    surface skips policy." Added `Interstitial.dismissTargetPurpose` to
    the schema so `dismiss` has something declared to click.
  - A click can trigger its own navigation (a form submit) that was never
    explicitly requested as a `navigate` step and so was never
    policy-checked as one. Added a post-click check in
    `PlaywrightSurfaceAdapter`: if the URL changed after a click, the
    resulting route is checked against the allowlist too — a best-effort
    safety net against a hijacked or unexpectedly-redirecting control
    (the concrete form the prompt-injection containment argument takes).
  - Caught by inspecting the RAW evidence, not by a passing test: both
    new fixture gates were initially unscoped ("any member not yet
    acknowledged" instead of "member 44444 specifically"), so *every*
    member's first load hit *both* interstitials. The runs still
    "succeeded" because generic recovery papered over it — exactly the
    failure mode "read the evidence, don't trust the green checkmark"
    exists to catch. Fixed by scoping each gate to its one member ID;
    re-verified the happy path is now genuinely interstitial-free
    (`grep -c RECOVERY_ATTEMPTED` = 0) while 44444/55555 each fire
    exactly their own recovery once.

  Gate: `evidence/replay-recovered-dialog/` and
  `evidence/replay-recovered-slow-load/`, both `status: success` with the
  correct member-specific outputs, each showing exactly one
  `RECOVERY_ATTEMPTED` event of the right kind. Redaction re-verified by
  grep across all five evidence directories for all four member IDs used
  so far — no leaks.

- [x] **Slice 5 — Session broker + handoff.** A third member fixture,
  `33333`, is the genuinely-stuck case: visually similar to 44444's
  auto-dismissable notice, but its interstitial is declared
  `handle: 'escalate'` — the engine never attempts to clear it itself.
  `ReplayRun.escalate()` is the single escalation path all three
  "can't safely proceed" sites in the engine call (previously three
  copies of the same suspend/notify logic): AUTOMATION -> NONE (release)
  -> HUMAN (operator claims) -> NONE (operator resumes) -> AUTOMATION
  (worker re-claims). `src/session/broker.ts` persists the
  `InterventionRequest` and a `SessionHandle` (the live connection info) to
  the run's own evidence directory — the seam both processes agree on
  without needing a shared registry for this single-run demo.

  Two real problems surfaced and fixed while making this genuinely work,
  not simplified around:

  1. **`launchServer()` + `connect()` does not do what it looks like it
     does.** Verified directly with a throwaway script: a second
     `chromium.connect(wsEndpoint)` call to a `launchServer()` browser
     gets an isolated view with zero contexts, even though the first
     client's context demonstrably still exists. That pairing is for
     *sequential* reuse (one test disconnects, the next connects fresh),
     not concurrent multi-client access — the opposite of what a same-
     session handoff needs. Switched the adapter to `chromium.launch()`
     with a real `--remote-debugging-port` exposed, and both the worker
     and the operator console attach via `chromium.connectOverCDP()` —
     verified this actually shares contexts/pages across simultaneous
     independent clients before building anything else on top of it.
  2. **Re-grounding checked the postcondition exactly once.** The
     operator's click demonstrably worked (confirmed by reading the
     `operator-after-action.png` evidence directly), but the worker's
     first re-grounding attempt still reported the postcondition unmet —
     an operator action can itself trigger a redirect chain / iframe
     reload still settling in the instant resume fires. Fixed by
     re-deriving position with the same bounded `waitForCondition` every
     other postcondition in the engine already uses, instead of a single
     instant `checkCondition`. Re-grounding deserves the same patience as
     the original action.

  Gate: `evidence/replay-handoff/` — worker suspends on member 33333's
  unresolvable notice, a genuinely separate operator-console process
  (`npm run operator`) attaches via CDP to the identical live browser,
  claims the intervention, clicks the real "Acknowledge and escalate"
  control (screenshotted before/after as evidence), resumes with a note,
  and the worker re-grounds and completes: `status: success`, correct
  member-specific outputs. `events.jsonl` shows the full
  `INTERVENTION_REQUESTED -> CONTROL_TRANSFERRED(HUMAN) -> HUMAN_ACTION
  (click) -> HUMAN_ACTION (resume) -> CONTROL_TRANSFERRED(AUTOMATION) ->
  AUTOMATION_RESUMED -> RUN_COMPLETED` sequence with real timestamps; the
  operator's note lands in `run-state.json`'s `operatorNotes`. Redaction
  re-verified: no raw `33333` anywhere in the evidence directory.

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
