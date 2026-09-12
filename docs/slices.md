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

  **Two gaps closed on review**, requirement 3.4 ("distinguish safe/
  reversible from risky/irreversible... handle the risky class
  conservatively"; "never persist secrets or raw sensitive data... into
  artifacts or logs"):

  1. **`mutating_reversible`/`risky_irreversible` had a real design but
     zero live exercise.** Every capability artifact in the repo declared
     every step `read_only`; the two higher risk classes were only ever
     reached by calling `evaluatePolicy()` directly with a synthetic
     `ProposedAction` in a unit test — the exact "declared but never
     exercised" pattern already found and closed twice this session
     (3.2's array-shape cut, 3.3's dead failure codes). The whole
     "sub-account creation" semantic-purpose group was scaffolded in
     `semanticPurposes.ts` for exactly this and never used by anything.
     Closed with two new, real, hand-authored capabilities:
     `member.create-sub-account` (`mutating_reversible` — opens a real
     account) and `member.close-sub-account` (`risky_irreversible` — a
     genuine, permanent deletion; the first real use of `commitBoundary`
     and its `idempotencyProbe` field too). Live-verified: `create` under
     `UNATTENDED` mode correctly stops with `needs_human` ("Risk class
     'mutating_reversible' exceeds the unattended ceiling
     'safe_reversible'"); the identical capability under `--mode ATTENDED`
     runs to completion and genuinely creates account `SAV-90000`. `close`
     stops with `needs_human` in *both* modes, word-for-word the same
     reason ("risky_irreversible actions always require an explicit,
     in-the-moment human decision") — proving the mode-independence a bug
     fix earlier in this project specifically guarantees, now shown
     against a real capability rather than only a unit test. Then carried
     through a full resume cycle on the real operator console: `POST
     /act` clicked the actual "Confirm Close" button on the live
     suspended session (the same account just created), `POST /resume`
     handed control back with an operator note, and the worker
     re-grounded to `status: success` — `SAV-90000` genuinely deleted,
     the full `AUTOMATION → HUMAN → AUTOMATION` event trail intact,
     `operatorNotes` populated. Not simulated at any point.
  2. **A live redaction leak, found by pulling an actual screenshot
     rather than trusting the design doc's claim.** The existing
     `<input>`-masking mechanism in `captureEvidenceScreenshot()` only
     covers a sensitive value that was *typed* somewhere; it does nothing
     for a value the app itself echoes back as plain rendered text.
     Opening `evidence/replay-business-outcome/business-outcome.png`
     showed the raw `memberId` ("99999") sitting unredacted in a "no
     member found" banner. Fixed with a DOM text-node sweep
     (`redactSensitiveTextAcrossFrames` in `src/surface/evidence.ts`):
     immediately before every evidence screenshot, every frame's text
     nodes are scanned for the run's actual sensitive input values and
     swapped for `[REDACTED]` in place, then restored right after — same
     at-capture-not-at-write discipline as the `<input>` masking, just
     extended past elements to content. Re-verified live: the
     regenerated screenshot now reads "No member found for identifier
     [REDACTED]."; the happy-path screenshot (no sensitive text on that
     page at all) is byte-for-byte unaffected, confirming the fix is
     precise, not a blanket blur.

  Full regression re-run after both changes: every pre-existing member
  scenario (12345, 44444, 55555, 33333, 88888, 22222, 00000, 99999)
  replayed live and unchanged. 72/72 unit tests green. Redaction
  re-verified clean by grep across every evidence directory, old and new.

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

  **Two gaps closed on review**, requirement 3.5 ("a structured log of
  what the agent did and why, and at least one richer signal on
  failure"):

  1. **The log recorded "what," rarely "why."** `ACTION_STARTED` only
     ever carried `{action: step.action}` -- a reader would have to open
     the artifact file and look up the stepId to learn what a step was
     *for*, even though `CapabilityStep.intent` (a human-readable field
     that exists specifically for reviewability) was sitting right there
     unused. Worse, checking every place a `business_outcome` result gets
     constructed found three of five call sites -- after a human resume,
     after interstitial recovery, on postcondition timeout -- never
     emitted `BUSINESS_OUTCOME_DETECTED` at all, and a fourth carried
     `code` but not the outcome's human-readable `message`. Fixed by
     adding `intent` to `ACTION_STARTED`, `matchedPurpose` to
     `RECOVERY_ATTEMPTED` (which interstitial fired, not just how it was
     handled), and consolidating all five business-outcome sites into one
     `returnBusinessOutcome()` method -- the same "one shared method, not
     N duplicated copies" discipline `escalate()` already followed,
     applied here specifically because duplicated logic is exactly how
     three of five sites silently drifted out of sync with the other two.
  2. **`ESCALATION_UNAVAILABLE` (a resume timing out) had zero fresh
     evidence of its own.** The only screenshot on file for this failure
     was `needs-human.png`, captured whenever escalation was *first*
     requested -- potentially stale by however long the timeout waited.
     Fixed with a screenshot taken at the actual moment of that failure.
     Live-verified with a 3-second resume timeout against member `33333`:
     both `needs-human.png` (the original trigger) and
     `escalation-unavailable.png` (the state when automation gave up) now
     exist side by side.

  Live-verified afterward: happy path (`12345`) shows `intent` on every
  `ACTION_STARTED`; the dialog interstitial (`44444`) shows
  `matchedPurpose: "unknown dialog dismiss"`; all three business-outcome
  scenarios from the 3.3 gap closure (`MEMBER_NOT_FOUND`,
  `VALIDATION_ERROR`, `PERMISSION_DENIED`) now emit
  `BUSINESS_OUTCOME_DETECTED` with both `code` and `message`, from three
  different call sites (precondition check, post-action check, and the
  `open-accounts` postcondition path respectively) -- proof the
  consolidation actually reaches every path, not just the one that was
  manually patched first. 72/72 unit tests green throughout; full
  regression across every pre-existing member scenario plus the verified
  `v2` artifact, unchanged. Redaction re-verified clean.

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

  **Three gaps closed on review**, requirement 3.3's own named runtime
  conditions ("a validation error, a 'record not found' result, a
  permission denial, an unexpected dialog, a session timeout, or a
  slow/failed load"). Record-not-found, unexpected-dialog, and
  slow/failed-load were all live-demonstrated above; a careful re-check
  found the other three were declared vocabulary with nothing behind
  them — `'permission denied banner'` and `'validation error banner'`
  sat unused in the closed semantic-purpose list, and `SESSION_EXPIRED`/
  `SESSION_LOST` sat unused in `FailureCodeSchema`, none ever referenced
  by a fixture, a `knownOutcome`, or any other code path.

  Closed with real fixtures, not just schema entries: `00000` is a
  well-formed-but-reserved identifier the app's own search rejects
  in place (no redirect at all — the search page re-renders with a
  validation banner, which is what makes it unambiguously a search-time
  failure rather than a lookup failure); `88888` is a real member whose
  accounts route always answers "access restricted" instead of data; and
  `22222` is a real member whose first accounts request per session
  destroys the session server-side and redirects to `/login`, simulating
  a mid-flow timeout deterministically. Two new `knownOutcomes` entries
  (`VALIDATION_ERROR`, `PERMISSION_DENIED`) cover the first two; the third
  needed a new, capability-level `sessionLoss` field
  (`{detect: Condition, code: 'SESSION_EXPIRED'|'SESSION_LOST'}`,
  `src/contracts/capability.ts`) since a session drop isn't a business
  result reached WITHIN the flow (`knownOutcomes`) or a dismissible
  overlay ON the current page (`interstitials`) — it's a change in WHICH
  page you're on. Checked in `src/replay/engine.ts` at every step
  boundary business outcomes are also checked at, ahead of them (a lost
  session is more fundamental than any business-outcome banner the flow
  declares), via `capability.sessionLoss.detect: {type: 'urlMatches',
  pattern: '/login'}`. Deliberately a hard `failure`, not a recoverable
  condition or a retry: this build has no credential-refresh flow to fall
  back on (the existing `reauth` interstitial handler is already a
  declared no-op for exactly this reason).

  A real targeting bug surfaced on the very first live run, caught by
  reading the actual result rather than trusting a clean exit: giving the
  two new banners the SAME role-only `role_and_name` strategy the
  original "member not found" banner used (`role: 'alert'`, empty name —
  "any accessible name") made all three indistinguishable to the
  resolver. Replaying `memberId=00000` reported `MEMBER_NOT_FOUND`
  instead of `VALIDATION_ERROR`, because `knownOutcomes` are checked in
  declared order and the first one whose role-only selector matched
  anything won, regardless of which banner the page actually rendered. A
  second attempt — matching on a substring of each banner's own message
  text instead of an empty name — didn't resolve at all: `role="alert"`
  does not derive its accessible name from content per the ARIA naming
  spec, so a text-content match silently finds nothing rather than
  erroring. Fixed by giving each banner div an explicit `aria-label` and
  matching on it with `exact: true`. Re-verified live afterward: all
  three new scenarios report their correct, distinct outcome
  (`evidence/replay-validation-error/`, `evidence/replay-permission-denied/`,
  `evidence/replay-session-expired/` — the last a genuine `status:
  "failure", code: "SESSION_EXPIRED"`, the first time that code has ever
  actually fired), and every pre-existing member (12345, 44444, 55555,
  33333) still passes exactly as before. 72/72 unit tests green (7 new,
  covering `sessionLoss`'s optionality, its default code, its closed
  enum, and its inclusion in `validateTargetRegistryIntegrity`).
  Redaction re-checked across every new evidence directory — clean.

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

  **A real gap closed on review**, requirement 3.6's own three named
  triggers ("the agent is stuck during discovery, a replay hits a
  condition it can't recover from, or a risky/irreversible step needs a
  person to decide"). The second and third were solidly built and
  live-verified above and in the 3.4 gap closure; the first -- discovery
  getting stuck -- was not. `runDiscovery()`'s every stuck path
  (`TIMEOUT`, `REPEATED_STATE`, `MAX_STEPS`, the model calling
  `request_human()` itself) wrote a `stuck` trace summary and closed the
  browser in a `finally` block, indistinguishable from a hard `failed`
  run: no `intervention.json`, no `session-handle.json`, and the browser
  already gone by the time anyone could react -- structurally impossible
  to hand off, not just unimplemented. `InterventionRequestSchema` had
  already been designed for this (`capabilityId` and `goal` as separate
  optional fields, an unused `observationRef`) but nothing ever exercised
  that half of it.

  Closed by giving discovery its own `escalateDiscovery()` (`src/
  discovery/loop.ts`), reusing `writeIntervention`/`writeSessionHandle`/
  `waitForResolution` from `src/session/broker.ts` verbatim rather than
  re-implementing the mechanism a second time. Opt-in via
  `--wait-for-handoff` on `scripts/discover.ts` (mirroring `replay.ts`'s
  own flag exactly), so the default one-shot CLI behavior --
  `--auto-compile`'s pipeline included, which has no operator standing by
  -- is unchanged. Each stuck condition resumes into its OWN fix, not a
  generic retry: a resumed `TIMEOUT` gets a fresh deadline, a resumed
  `MAX_STEPS` gets a fresh step budget, a resumed `REPEATED_STATE` resets
  the repeat counter -- all three needed the `for` loop's own bound
  restructured from the loop's condition into an in-body check (mirroring
  how the deadline check already worked) so `MAX_STEPS` could be extended
  rather than being a hard ceiling the loop physically couldn't exceed.
  One trigger stayed deliberately unescalated: `ENTRY_ROUTE_BLOCKED` (and
  a mid-run `policy_denied`) is a containment-boundary failure, not a
  live-page obstacle -- there's nothing on screen to act on, and routing
  it to a human would invite working around the boundary rather than
  honoring it.

  The operator console (`scripts/operator-console.ts`) needed a real
  extension, not a workaround: discovery has no capability artifact yet,
  so there's no `targetRegistry` for a `targetPurpose`-based quick-action
  to resolve against. `--capability`/`--version` are now optional, and a
  new `/act-by-text` endpoint clicks by raw visible text instead (the
  same last-resort mechanism the targeting ladder's own `visible_text`
  rung already uses) -- weaker than a semantic purpose, but a real click
  on the real live session, not a simulation. Works for a replay
  intervention too; verified by closing a real sub-account
  (`member.close-sub-account`) through `/act-by-text` instead of the
  original `targetPurpose`-based `/act`, confirming the new path and the
  old one both still work.

  Live-verified end to end, repeatedly: a genuine LLM-driven discovery
  run forced into `TIMEOUT` on its first check (`--timeout-ms 100`, small
  enough that browser launch + login alone exceeds it) suspended with a
  real `intervention.json`/`session-handle.json`; the operator console
  (no `--capability` given) correctly showed "Discovery goal" instead of
  "Capability" and omitted the capability-specific quick-action, keeping
  only the generic form. Resumed four separate times through the same
  live session (the artificially tiny timeout kept re-firing, which
  incidentally proved the mechanism survives repeated suspend/resume
  cycles without drift or corruption) -- automation continued between
  each one (real `type`/`click` trace entries, not no-ops) and the run
  *completed the original goal for real* afterward: `status: "success"`,
  the correct member's real balance, memberId correctly `[REDACTED]` in
  the summary. `events.jsonl` shows four clean `INTERVENTION_REQUESTED ->
  CONTROL_TRANSFERRED(HUMAN) -> HUMAN_ACTION -> CONTROL_TRANSFERRED
  (AUTOMATION) -> AUTOMATION_RESUMED` cycles. The original Slice 5 demo
  (member 33333, `targetPurpose`-based `/act`) re-verified unaffected
  afterward. 72/72 unit tests green throughout. Redaction re-verified
  clean across every new and touched evidence directory.

- [x] **Slice 6 — Discovery loop.** `observeWithMarks()` (moved from
  Slice 2 as planned — replay never needs it): every interactive element
  in the top frame and named child frames gets a `data-discovery-mark`
  attribute and a numbered visual badge (top frame only — badging across
  an iframe boundary needs coordinate translation not worth the
  complexity for one iframe); the model refers to controls only by mark
  number. Claude (Sonnet 5, standard effort — this is a narrow one-tool-
  from-six-options decision per turn, not deep multi-step reasoning, so a
  large thinking budget would mostly add latency/cost across ~15 turns
  without a quality gain), native tool use with `tool_choice: {type:
  "any"}` forcing exactly one call per turn, prompt caching on the system
  prompt and tool definitions, screenshots truncated to the last 2 turns.
  Stop conditions: max steps, wall-clock timeout, repeated state
  fingerprint, model-initiated `finish`/`request_human`, policy denial.
  The `{{inputs.NAME}}` placeholder mechanism is real here too: the model
  is told input NAMES only and types `{{inputs.memberId}}` as a literal
  value string; `PlaywrightSurfaceAdapter`'s discovery methods substitute
  it at the surface boundary, same as replay.

  **Gap closed on review**: requirement 3.1 asks the loop to "accept a
  goal + a target (app/URL/entry point) as input." The goal always was a
  real CLI input; the target/entry-point originally weren't — the base
  URL only came from an environment variable (no `--target` flag existed
  at all), and the entry point was implicit in `scripts/discover.ts`'s
  login helper hardcoding a wait for `/member-search` specifically. Fixed
  by making both first-class: `--target-url` and `--entry-route` are now
  real flags, `DiscoveryOptions.entryRoute` is a required field on the
  loop itself, and `runDiscovery()` navigates to it explicitly (a
  policy-checked action, same as everything else) rather than inferring
  "wherever login happened to land" as the starting point. Login
  (`loginToTargetApp`) now only authenticates and waits to leave
  `/login` — it no longer knows or cares what page comes after. Verified
  live with a genuine discovery run supplying both flags explicitly
  (`--target-url http://localhost:4173 --entry-route /member-search`,
  `evidence/discovery-run-explicit-target/`) — correct member-specific
  output, redaction clean.

  Gate (`npm run discover`): a genuine Sonnet 5 run completed "look up
  member {{inputs.memberId}} and read their savings balance" against the
  live target app in 4 steps (type, click, click, finish), correctly
  reporting balance/account-id/currency matching the fixture. This is the
  one thing the brief says cannot be faked.

  Two real things caught by reading the evidence, not by the run merely
  "succeeding":
  - **The goal text itself leaked the raw value.** First attempt phrased
    the goal as "Look up member 12345..." (a natural thing to type) --
    the model dutifully echoed "12345" back in its own `finish()` output
    and summary, and neither `summary.json` nor the CLI's own stdout was
    redacted at that boundary (only the per-step trace already was).
    Fixed at both ends: the goal must use the same `{{inputs.NAME}}`
    placeholder convention as a `type` action (`runDiscovery` now
    refuses to even launch a browser if the goal contains a raw
    sensitive value verbatim, rather than trusting every caller to
    remember), and every terminal result (`finish`, `request_human`) is
    now redacted before it's written or returned, not just the trace.
  - **The placeholder mechanism has a real, unavoidable limit.** Even
    after that fix, the model's summary still originally contained the
    raw member ID -- because it never called `extract()` on it at all.
    The trace shows only `type -> click -> click -> finish`: the model
    read the member's name and ID directly off the *screenshot* (the
    target app's own member-detail page renders `Member: Jordan Alvarez
    (12345)`, a realistic thing for a real banking app to do), which is
    a vision channel the placeholder substitution never touches. The
    control-plane protection (nothing WE construct -- goal, tool
    results, logs -- ever contains the raw value) holds; it cannot
    prevent a vision-capable agent from reading whatever the target
    application itself renders back on screen, which is a distinct,
    documented limit (REPORT.md Safety), mitigated by redacting every
    output at the persistence boundary rather than by pretending the
    model never saw it.
  - Consequence for Slice 7: since the model never issued an explicit
    `extract` action, the raw trace contains no extraction step to
    compile from -- confirming (not just motivating in the abstract) why
    the compiler needs a second pass to synthesize the checkpoint and
    output-extraction steps from final page state, rather than a
    mechanical trace replay.

- [x] **Slice 7 — Compiler + verification gate.** Trace -> artifact.
  Scoped the LLM's job narrowly to what genuinely needs judgment:
  classifying each control the discovery run *acted on* against the
  closed semantic vocabulary, plus proposing the checkpoint (one call,
  fresh context, no discovery history). Everything else is mechanical --
  output *locations* are declared by the caller as a typed contract
  (name, type, description, which `<th>` column header identifies it)
  and found by a real DOM query (`tableLookup.ts`), not guessed from
  whatever free text the exploring model happened to write in its own
  summary. Compile-time uniqueness is enforced by literally replaying the
  trace's actions live and calling the SAME `resolveTarget()` the replay
  engine uses to verify each target resolves to exactly one match before
  it's ever written into the artifact.

  Three real problems found and fixed while making this actually
  compile-and-verify, not simplified around:
  1. **The model's output naming isn't stable across runs.** Two
     discovery runs of the identical goal produced differently-shaped
     `outputs` (`{savings_balance, currency, account_id}` vs.
     `{savings_balance: "4235.67 USD", account_id}`, combining fields).
     Confirmed this is real non-determinism, not a one-off — which is
     exactly why output extraction is a declared contract mechanically
     resolved, not parsed from the model's free text.
  2. **A second, independent accessible-name bug**, caught by reading the
     regenerated trace directly: the "Search" button's name computed as
     `""`. The table-row-adjacency heuristic ran *before* checking a
     button/link's own text content, and since Search sits in a row whose
     preceding cell is empty, the row heuristic "won" with an empty
     string instead of falling through. Fixed the precedence order in
     `setOfMarks.ts`; buttons/links now check their own text first.
  3. **The compiled artifact had no postconditions at all** — the first
     verification replay failed with `ADAPTER_ERROR` because
     `extract-balance` ran immediately after the "Accounts" click,
     before the accounts-frame iframe had loaded. The hand-authored
     artifact avoids this by hand; the compiler wasn't synthesizing the
     equivalent. Fixed with a general, defensible heuristic sound for any
     linear discovery trace: every click step's postcondition is "the
     next step's target becomes visible." Also hardened the compiler's
     own live replay with a settle wait after each click, since
     compile-time had been passing on unguarded timing luck, not
     correctness, before this fix existed.

  Gate: `npm run compile` (one real LLM classification call) ->
  `capabilities/member.read-savings-balance.v2.json` (status `draft`) ->
  `npm run replay ... --input memberId=67890` (a member discovery never
  saw) -> `status: success` with correct member-67890-specific outputs,
  postconditions holding, checkpoint passing -> `npm run promote` ->
  `status: verified`. Regression-checked against the original discovery
  input (12345) afterward — both members work. Redaction re-verified
  across compile and verification evidence — clean.

  **Two gaps closed on review**, requirement 3.2 ("after a successful
  run, emit a typed, serializable artifact"; "typed outputs / data to
  extract and their shape"):

  1. **Emission wasn't automatic.** `npm run compile` always existed but
     was a second, separate command an operator had to remember to run —
     nothing made emission happen *as a consequence of* a successful run,
     which is the literal ask. Closed with `--auto-compile` on
     `scripts/discover.ts`: a successful discovery run now compiles
     straight into a draft artifact in the same command, taking
     `--output-schema <path>` (validated against the new
     `DesiredOutputFileSchema`) plus `--capability-id`/`--version`. It
     automates only that one step — verification and promotion stay
     separate, deliberate commands, so "verified" keeps meaning something
     was actually confirmed to generalize, not just that compilation
     didn't throw. `capabilities/member.read-savings-balance.v3.json` was
     produced this way end-to-end, then verified on `memberId=67890` and
     promoted.
  2. **"Shape" was a flat type tag, not a structure.** `OutputDef.type`
     was `'string'|'number'|'boolean'|'decimal'` — one flat field per
     extracted fact, with no way to express that `balance`, `currency`,
     and `accountId` are three facets of one `account`, which is what a
     calling agent actually wants back. Replaced with a recursive
     `OutputShape` (`src/contracts/capability.ts`): scalar, or
     `{type:'object', properties}`, or `{type:'array', items}`.
     `OutputDefSchema.superRefine` enforces a shape-appropriate producer
     contract, not just shape validity — a scalar needs `sourceStepId`;
     an object needs `sourceStepsByProperty` naming a step for *every*
     declared property (checked by name, so a silently-missing producer
     fails validation); an array is declarable in the schema with no
     producer requirement, because replay has none yet —
     `src/replay/assembleOutput.ts` throws a named error for an array
     shape instead of assembling something empty or wrong. The compiler
     (`src/compiler/index.ts`) now takes a `DesiredOutput[]` of named,
     multi-field groups rather than one flat field list; single-field
     groups still compile to a plain scalar output, multi-field groups
     compile to an object with `sourceStepsByProperty`. Live-verified the
     full chain, not just the schema: recompiled `v2` and freshly
     auto-compiled `v3` both emit `outputs.account` as a real nested
     value; the MCP server's `tools/list` description renders it
     recursively (`account (object: balance (decimal), currency
     (string), accountId (string))`); a live `tools/call` against `v3`
     returned `{"account":{"balance":"9310.25","currency":"USD",
     "accountId":"SAV-40988"}}` — the nested structure survives replay,
     the catalog, and the MCP wire format, not just the artifact JSON at
     rest. 65/65 unit tests green (7 new for `OutputDefSchema`, 3 new for
     `assembleOutput`), `validate:artifacts` green across all three
     artifact versions, redaction re-verified clean.

  Documented limitation: `knownOutcomes` and `interstitials` are empty in
  the compiled artifact — a single happy-path discovery run has no way to
  discover a not-found banner or a recoverable dialog it never
  encountered. A real pipeline would merge multiple discovery runs (or
  accept manual authoring for these, as v1 demonstrates) rather than
  expect one run to produce a complete error taxonomy.

- [x] **Slice 8 — Multi-tenant resolution (stretch).** `TenantBindingSchema`
  (`src/contracts/tenantBinding.ts`): a binding carries only entry URL,
  auth profile reference, and `targetOverrides` keyed by the same
  `semanticPurpose` strings `targetRegistry` uses — it can replace *how*
  a control is found, never add a step or change the checkpoint.
  `resolveCapability(base, binding)` (`src/multitenant/resolve.ts`) is a
  pure function: override replaces a purpose's candidates outright (no
  field-by-field merge that could leave a stale base candidate silently
  coexisting with a tenant's), `scope.allowedOrigins` swaps to the
  binding's `entryUrl`, everything else passes through untouched —
  verified by asserting non-overridden `targetRegistry` entries, steps,
  and the checkpoint are `toEqual` the base capability's own.
  `resolvedFrom[]` now carries the full chain (`ReplayOptions.resolvedFromExtra`),
  not just the base capability.

  Variant B of the target app (`TENANT_VARIANT=B`): same vendor product,
  different white-label wording ("Customer Number" for "Member ID",
  "Products" for "Accounts") — a realistic two-credit-unions-one-core-
  banking-product scenario, not a synthetic difference invented for the
  demo.

  Gate: the SAME `member.read-savings-balance@2` artifact — recorded via
  discovery and verified against tenant A on port 4173 — replayed via
  `credit-union-b`'s binding against variant B on port 4174 (different
  labels, different port) and returned `status: success` with correct
  outputs. No re-recording, no re-discovery; five new unit tests
  (`tests/multitenant/resolve.test.ts`) plus the live cross-tenant run.

- [x] **Slice 9 — Capability catalog (stretch).** `src/catalog/index.ts`
  turns every `verified`/`approved`, `UNATTENDED`-capable artifact into
  an Anthropic tool definition, generated from the SAME
  `CapabilityDefinitionSchema` that validates the artifact on disk — one
  source of truth for the shape, not a hand-maintained second one.
  `loadCatalog()` deliberately excludes `draft` artifacts: v1 (hand-
  authored, still draft) never reaches the catalog; only v2 (verified in
  Slice 7) does.

  Gate (`npm run catalog:demo`): given the catalog and the plain-language
  request *"What is member 12345's current savings balance?"*, Claude
  selected `member_read-savings-balance_v2` and supplied
  `{"memberId":"12345"}` with no other prompting — genuine tool discovery
  and typed-argument invocation, not a hardcoded call. Deterministic
  replay executed it (`llmCalls=0` inside the execution itself); Claude's
  follow-up turn produced a correct natural-language answer from the real
  result. Redaction re-verified clean in `evidence/catalog-invocation/`.

  This closes the loop on the brief's own framing for the artifact: "an
  agent-invocable capability."

- [x] **Slice 10 — Route canonicalization + multi-run stability
  (stretch).** Two more named stretch goals, added on request after
  confirming what was and wasn't already built:

  **Canonicalization** (`src/compiler/canonicalize.ts`): the compiler now
  derives `scope.allowedRoutes` from routes actually visited during its
  own live replay, rather than a hand-typed list — `/member/12345/accounts`
  becomes `/member/:memberId/accounts` by replacing any path segment that
  exactly matches a declared input's value (not a generic "looks like an
  ID" heuristic, an exact-match lookup against the same values the
  compiler already used to reach that page). Recompiling immediately
  surfaced a real, structural gap: `evaluatePolicy`'s route matcher only
  understood `*` glob wildcards, so a `:memberId`-style pattern would
  have failed its own policy check at replay time — fixed in
  `src/policy/allowlist.ts` before it ever shipped, with tests
  confirming `:name` matches exactly one path segment (not a deeper
  path). A **second** real defect surfaced on the same recompile:
  classification's checkpoint proposal isn't always confined to the
  truly final page state — one run proposed a checkpoint including a nav
  link from two steps earlier, on a page that link no longer exists on,
  and the artifact failed its own verification replay as a direct
  result. Fixed by verifying every proposed checkpoint purpose against
  the live final page before including it (same "verify a proposal,
  don't just trust it" rule the targeting ladder already follows) —
  refusing to compile at all if verification leaves zero purposes,
  rather than ever emitting an empty (trivially-always-true) checkpoint.
  Full regression chain re-run and green after both fixes: Slice 7's
  gate (67890), the original discovery input (12345), the Slice 8
  cross-tenant replay against variant B, and the Slice 9 catalog demo.

  **Multi-run stability** (`scripts/stability.ts`): replays the same
  capability + input N times, aggregating success rate and per-step rung
  consistency (a step resolving via more than one candidate rung across
  otherwise-identical runs is a real drift signal even when every run
  individually succeeds) into a `stable: boolean` verdict. Run for real:
  5/5 successes, zero rung drift across every step, ~660ms average per
  replay against `member.read-savings-balance@2` with `memberId=67890`.

  **A gap in the verification process itself, caught by being asked
  directly "have you recorded evidence of testing the final
  implementation."** Checking properly surfaced a real answer, not a
  reflexive "yes": the long-running MCP server process (`npm run mcp`)
  had been started *before* this slice's compiler/policy changes and
  loads its catalog once at startup — it was silently serving a stale,
  pre-fix artifact the whole time those changes were being made and
  committed. Restarted it and re-verified `tools/call` against the
  actually-current artifact. Separately, the policy route-matcher
  refactor (this slice) had only been *unit*-tested against v1's `*`
  wildcard-style routes, never live-replayed afterward — re-ran v1's
  happy path and business-outcome cases live against the current code to
  close that gap too, both green. The general lesson, stated plainly: a
  long-running process holding state in memory is a place evidence can
  quietly go stale even when the file on disk and the git history are
  both correct — worth checking explicitly, not assuming from a clean
  `git status`.
