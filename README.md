# interface_replay_ai

A computer-use automation system: an LLM discovers how to complete a goal in
a live legacy-style banking UI, the successful run is compiled into a typed,
versioned **capability artifact**, and a deterministic runtime replays that
artifact in production with no LLM in the decision loop — escalating to a
human when it can't safely proceed.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how an AI agent invokes it in production.

Build status: **all 9 slices complete**, plus three of six optional
stretch goals built in full (§8) — more than the brief's own "pick at
most one or two," defended directly in
[`STRETCH_GOALS.md`](STRETCH_GOALS.md). See
[`docs/slices.md`](docs/slices.md) for the full build history,
[`REPORT.md`](REPORT.md) for the design write-up,
[`COMPLIANCE.md`](COMPLIANCE.md) for a requirement-by-requirement
ask/status/evidence mapping (§3.1–3.7), and
[`ARCHITECTURAL_DECISIONS.md`](ARCHITECTURAL_DECISIONS.md) for the
defense of every explicitly-our-call choice (§4),
[`GLOSSARY.md`](GLOSSARY.md) for the brief's own terms, each pointed at
where it actually shows up in this repo, and
[`FORWARD_DESIGN.md`](FORWARD_DESIGN.md) for a design-only proposal
(a shared, vendor/app-scoped component library; provider-neutral
discovery) building on `COMPLIANCE.md` §3.7 — not built, diagrams included.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run build              # type-check + compile
npm test                   # contract schema tests
npm run validate:artifacts # validate every artifact in /capabilities against the schema
npm run emit:jsonschema    # regenerate capabilities/schema.json from the Zod source of truth
```

**Keys/config needed:** exactly one — `ANTHROPIC_API_KEY`. Copy
`.env.example` to `.env` and set it there. Nothing else in this repo
needs a key, a database, or any external service.

**Running without live services.** Everything below works against the
local target app with **no internet access and no API key** *except* the
two commands that must call a real LLM (`npm run discover`,
`npm run compile`) — those are the one part of this project the brief
itself says can't be mocked. Concretely: `npm run build`, `npm test`,
`npm run validate:artifacts`, the target app itself, and every
`npm run replay` / `npm run smoke:adapter` / `npm run operator` /
`npm run stability` / `npm run promote` command in this README run fully
offline once `npm install` has completed, using only artifacts already
committed in `/capabilities`. Start the target app first, in its own
terminal, before any of those:

```bash
npm run target-app
# Target app listening on http://localhost:4173
# Login with username="operator" password="demo-pass-1234"  (synthetic, not a real credential)
```

## Demo path

The exact commands to run the agent on a goal, then replay the resulting
artifact. Requires `ANTHROPIC_API_KEY` (see Setup) and the target app
running (`npm run target-app`, above).

```bash
# 1. Run the agent on a goal -- a genuine claude-sonnet-5 tool-use loop
#    against the live target app, no pre-existing artifact involved.
#    --auto-compile means a successful run is saved as a capability
#    artifact automatically, in this same command.
npm run discover -- \
  --goal "Look up member {{inputs.memberId}} and read their current savings balance" \
  --target-url http://localhost:4173 --entry-route /member-search \
  --input memberId=12345 --sensitive-input memberId --pattern memberId='^[0-9]{5}$' \
  --evidence-dir evidence/discovery-run-autocompile \
  --auto-compile --output-schema output-schemas/member-read-savings-balance.json \
  --capability-id member.read-savings-balance --version 3

# 2. Replay the resulting artifact -- a DIFFERENT input the discovery run
#    never saw, zero LLM calls (mode=REPLAY llmCalls=0 is printed because
#    there is structurally no LLM-client import in the replay engine).
npm run replay -- --capability member.read-savings-balance --version 3 \
  --input memberId=67890 --evidence-dir evidence/verify-autocompile
```

Command 1 writes `capabilities/member.read-savings-balance.v3.json` and a
full trace/screenshots to `evidence/discovery-run-autocompile/`. Command 2
succeeds with a *different* real balance (`memberId=67890` was never used
during discovery) — the mechanical proof the artifact was parameterized,
not just replayed the one input it was recorded against — and writes its
own run state/events/screenshot to `evidence/verify-autocompile/`.

See ["The end-to-end thread"](#the-end-to-end-thread) below for the same
two commands walked through in full, plus the artifact's own
`provenance.discoveryRunId` lineage, the error/outcome-handling taxonomy,
and a human-escalation cycle continuing directly from this same artifact
family.

### More replay scenarios

The two commands above are the minimal thread. `member.read-savings-balance`
`v1` (hand-authored, richer than `v3` — see "The end-to-end thread" for why)
demonstrates every outcome the replay engine handles, run by the identical
engine with zero LLM calls either way:

```bash
# Success
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=12345 --evidence-dir evidence/replay-success

# Business outcome -- a legitimate result, not a crash
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=99999 --evidence-dir evidence/replay-business-outcome

# Hard failure -- input rejected before anything touches the surface
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=abc --evidence-dir evidence/replay-failure

# Recoverable: an unexpected dialog, dismissed automatically once
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=44444 --evidence-dir evidence/replay-recovered-dialog

# Recoverable: a transient slow load, recovered by retry
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=55555 --evidence-dir evidence/replay-recovered-slow-load

# Business outcome: a validation error the APP itself rejects (well-formed,
# reserved) -- distinct from "not found", which only fires after a lookup
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=00000 --evidence-dir evidence/replay-validation-error

# Business outcome: permission denied -- a real member, permanently restricted
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=88888 --evidence-dir evidence/replay-permission-denied

# Hard failure: session expires mid-flow -- status: failure, code: SESSION_EXPIRED
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=22222 --evidence-dir evidence/replay-session-expired
```

## The end-to-end thread

The two-command demo path above is the minimal version of this. This
section is the full version: one continuous, reproducible path from a
goal all the way through a human-escalation cycle, with real evidence at
every stage — the specific thing §5 of the brief asks for ("a working
thread that runs all the way through"), told as one story instead of
assembled from separate demo sections.

**1. The goal.** `"Look up member {{inputs.memberId}} and read their
current savings balance"` — a genuine multi-step flow (search → detail
→ accounts, routed through a deliberately hostile iframe) against the
local target app, no pre-existing artifact involved.

**2. A real LLM-driven run that completes it.** The exact command from
"Demo path" above:

```bash
npm run discover -- \
  --goal "Look up member {{inputs.memberId}} and read their current savings balance" \
  --target-url http://localhost:4173 --entry-route /member-search \
  --input memberId=12345 --sensitive-input memberId --pattern memberId='^[0-9]{5}$' \
  --evidence-dir evidence/discovery-run-autocompile \
  --auto-compile --output-schema output-schemas/member-read-savings-balance.json \
  --capability-id member.read-savings-balance --version 3
```

A genuine `claude-sonnet-5` tool-use loop, 4 real steps, zero scripting —
`evidence/discovery-run-autocompile/trace.jsonl` records every
observation and decision; `summary.json` shows the real result
(`Jordan Alvarez, SAV-88213, 4235.67 USD`, `memberId` correctly
`[REDACTED]` in the human-readable summary).

**3. A saved capability artifact — automatically, as a consequence of
step 2 succeeding**, not a separate step the operator has to remember.
`--auto-compile` on the same command wrote
[`capabilities/member.read-savings-balance.v3.json`](capabilities/member.read-savings-balance.v3.json)
directly from the trace above; its own `provenance.discoveryRunId` field
points back at `evidence/discovery-run-autocompile`, making the lineage
from this exact discovery run to this exact artifact checkable, not
asserted.

**4. A deterministic replay of that artifact — different input, real
outputs, zero LLM calls.**

```bash
npm run replay -- --capability member.read-savings-balance --version 3 \
  --input memberId=67890 --evidence-dir evidence/verify-autocompile
```

`memberId=67890` was never used during discovery or compilation —
success here (`status: "success"`, a *different* real balance,
`SAV-40988`, `9310.25 USD`) is the mechanical proof the compiler
parameterized `memberId` rather than transcribing `12345`. `mode=REPLAY
llmCalls=0` is printed because there is structurally no code path in
`src/replay/engine.ts` that could make it anything else
(`tests/replay/no-llm-import.test.ts`). This artifact was then promoted
`draft → verified` (`npm run promote`) on the strength of that result.

**5. Error/outcome handling — the same deterministic engine, exercised
against its fuller sibling artifact.** One clean discovery run can only
compile what it actually saw, so `v3` above has no interstitials or
business outcomes to discover (an honest, disclosed limit — see
`REPORT.md`'s Cuts). The *engine* that ran it is exactly the same engine
that runs `v1` — hand-enriched with the full named taxonomy — so the
same mechanism is provably capable of all of it:

```bash
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=99999 --evidence-dir evidence/replay-business-outcome
# -> business_outcome, MEMBER_NOT_FOUND -- a legitimate result, not a crash
```

`evidence/replay-validation-error/`, `evidence/replay-permission-denied/`,
`evidence/replay-session-expired/`, `evidence/replay-recovered-dialog/`,
and `evidence/replay-recovered-slow-load/` are the same replay engine
correctly distinguishing a validation error, a permission denial, a
session timeout, a recoverable dialog, and a recoverable slow load —
five more real, independently-verified outcomes, not five variations of
the same demo.

**6. A human-escalation path that takes over the live session.** Member
`33333`'s notice is declared escalate-only — automation cannot safely
clear it itself:

```bash
# Terminal 1 -- suspends in place, same browser, same page
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=33333 --evidence-dir evidence/replay-handoff \
  --wait-for-handoff --resume-timeout-ms 900000
# Terminal 2 -- a genuinely separate process, attaches via real CDP to the SAME session
npm run operator -- --evidence-dir evidence/replay-handoff \
  --capability member.read-savings-balance --version 1
```

`http://localhost:4500` → viewing claims the intervention, a quick-action
clicks a real control on the live session, Resume (with a note) hands
control back — the worker re-grounds and completes on its own. The more
complete version of this same mechanism ("Risk-class handling demo"
below) carries a `risky_irreversible` mutation all the way through this
exact cycle to a genuine account deletion, not just a dialog dismissal.

**7. Evidence for both runs**, in one place, not scattered: everything
named above is a real directory under `evidence/` in this repo, checked
into git — screenshots, `events.jsonl`/`trace.jsonl`, and `result.json`/
`summary.json` for every step of this thread, reproducible by running
the commands above yourself against the local target app (see
"Verify it yourself" below).

## Verify it yourself

Every claim in this repo is designed to be checked directly, not taken on
faith. Three ways to do that, cheapest first.

### 1. Look at the actual screenshots

Every `npm run replay` / `discover` / `compile` / `catalog:demo` command
writes a real screenshot into its `--evidence-dir`. Just open the PNG
files under `/evidence/*/`. A screenshot lands on every terminal path --
`success`/`business-outcome`/`failure`/`session-lost`/`needs-human`, plus
a fresh one specifically for a resume timing out (`escalation-unavailable.png`,
distinct from `needs-human.png`'s snapshot at the *original* trigger,
which can be stale by the time a timeout fires).

`events.jsonl` in the same directory is the structured "what and why"
log: every `ACTION_STARTED` entry carries the step's own declared
`intent` (its human-readable purpose, straight from the artifact --
e.g. `"Permanently close the account -- the flow's point of no return"`),
so the log explains itself without needing the artifact file open
alongside it. A business outcome (`BUSINESS_OUTCOME_DETECTED`) carries
both its `code` and human-readable `message`; a recovered interstitial
(`RECOVERY_ATTEMPTED`) names which one (`matchedPurpose`), not just how
it was handled.

### 2. Browse the target app yourself, live, in your own browser

```bash
npm run target-app
```

Leave it running and open `http://localhost:4173` in a normal browser tab.
Log in with `operator` / `demo-pass-1234`, then try these — each is an
independent server-side fixture, so your manual session never collides
with anything a script is doing:

| Member ID | What you should see |
|---|---|
| `12345` | Happy path — Savings, SAV-88213, 4235.67 USD |
| `99999` | "No member found" banner (a business outcome, not an error page) |
| `44444` | An "unexpected notice" the first time you view its Accounts page — click "Continue" to get through it |
| `55555` | A "Loading account data..." placeholder the first time you view its Accounts page — reload to see the real table |
| `33333` | A notice with **no** way through in the UI itself — this is the one that requires the human-handoff flow (below), not a click |
| `67890` | A second clean happy path — Savings, SAV-40988, 9310.25 USD |
| `00000` | Type this into the search box: a validation banner in place, on the search page itself — no redirect, since the identifier is well-formed but rejected by the app's own rule |
| `88888` | Accounts page always shows "Access... restricted" instead of data — a real member, permanently permission-denied |
| `22222` | Accounts page redirects you straight back to the login screen with "Your session has expired" — simulates a session timing out mid-flow |

For a non-visual, scriptable version of the same check (every element on
a page, printed as text, plus a screenshot) without needing to click
through yourself:

```bash
npm run inspect -- --route /member/12345/accounts
```

(On git-bash/MSYS, prefix with `MSYS_NO_PATHCONV=1` or the leading `/` in
`--route` gets mangled into a Windows path.)

### 3. Drive the human-handoff flow live, watching both sides

```bash
# Terminal 1
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=33333 --evidence-dir evidence/replay-handoff \
  --wait-for-handoff --resume-timeout-ms 900000

# Terminal 2
npm run operator -- --evidence-dir evidence/replay-handoff \
  --capability member.read-savings-balance --version 1
```

Open `http://localhost:4500` — this is a real second process attached via
CDP to the exact browser Terminal 1 suspended, not a simulation. You can
also open `http://localhost:9333/json` in a browser at that point to see
the raw CDP target list Chromium is exposing (`CDP_PORT` in
`src/surface/adapter.ts`) — the same endpoint the operator console and
the compiler both attach to.

## Human handoff demo

Member `33333` shows a notice the capability declares escalate-only —
automation cannot safely clear it itself. Two terminals:

```bash
# Terminal 1: the replay worker. Suspends in place (same browser, same
# page) instead of returning immediately, and waits up to 15 minutes for
# an operator to resolve the intervention.
npm run replay -- --capability member.read-savings-balance --version 1 \
  --input memberId=33333 --evidence-dir evidence/replay-handoff \
  --wait-for-handoff --resume-timeout-ms 900000

# Terminal 2: the operator console -- a genuinely separate process that
# attaches to the SAME live browser via CDP (see docs/slices.md's Slice 5
# entry for why CDP specifically, not Playwright's own connect()).
npm run operator -- --evidence-dir evidence/replay-handoff \
  --capability member.read-savings-balance --version 1
```

Open `http://localhost:4500` — viewing the intervention claims it, "Click:
Acknowledge and escalate" acts on the live session, and Resume (with an
optional note) hands control back. Terminal 1 then re-grounds and
completes on its own. `evidence/replay-handoff/events.jsonl` records the
full `AUTOMATION -> HUMAN -> AUTOMATION` transfer with real timestamps.

## Risk-class handling demo (mutating_reversible / risky_irreversible)

`member.read-savings-balance` is entirely `read_only`. These two
capabilities exercise the other two risk classes end to end -- not just
via `evaluatePolicy()` unit tests -- against a dedicated demo member
(`56789`, starts with zero accounts so mutating it can never affect any
other capability's regression-checked fixture data).

```bash
# mutating_reversible: blocked by the default unattended ceiling...
npm run replay -- --capability member.create-sub-account --version 1 \
  --input memberId=56789 --input nickname="Emergency Fund" \
  --evidence-dir evidence/replay-create-subaccount-unattended
# -> needs_human: "Risk class 'mutating_reversible' exceeds the
#    unattended ceiling 'safe_reversible'."

# ...but auto-allowed once a human is attending (can intervene, doesn't
# need to pre-approve this specific action):
npm run replay -- --capability member.create-sub-account --version 1 \
  --mode ATTENDED --input memberId=56789 --input nickname="Emergency Fund" \
  --evidence-dir evidence/replay-create-subaccount-attended
# -> status: success, outputs: { newAccountId: "SAV-90000" } -- a real account

# risky_irreversible: blocked in BOTH modes, identically --
# "attended" means a human CAN intervene, not that this was pre-approved.
npm run replay -- --capability member.close-sub-account --version 1 \
  --input memberId=56789 --evidence-dir evidence/replay-close-subaccount-unattended
npm run replay -- --capability member.close-sub-account --version 1 \
  --mode ATTENDED --input memberId=56789 --evidence-dir evidence/replay-close-subaccount-attended
# -> needs_human in both, same reasonCode either way
```

To see the irreversible one actually complete (not just block), run the
same human-handoff pattern as above against `member.close-sub-account`,
then act on the real "Confirm Close" control and resume:

```bash
# Terminal 1
npm run replay -- --capability member.close-sub-account --version 1 \
  --input memberId=56789 --evidence-dir evidence/replay-close-subaccount-handoff \
  --wait-for-handoff --resume-timeout-ms 900000

# Terminal 2
npm run operator -- --evidence-dir evidence/replay-close-subaccount-handoff \
  --capability member.close-sub-account --version 1
```

The console's own `/act` endpoint takes any registered target purpose,
not just the one hardcoded button in its HTML -- `curl -X POST
http://localhost:4500/act --data-urlencode "targetPurpose=sub-account close confirm"`
clicks the real control on the live session, then `curl -X POST
http://localhost:4500/resume --data-urlencode "note=..."` hands control
back. The worker re-grounds and completes with the account genuinely
deleted -- `evidence/replay-close-subaccount-handoff/success.png` shows
"Account SAV-90000 has been closed."

## Discovery (genuine LLM-driven run, without auto-compile)

Requires `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`). With the
target app running:

```bash
npm run discover -- \
  --goal "Look up member {{inputs.memberId}} and read their current savings balance" \
  --target-url http://localhost:4173 --entry-route /member-search \
  --input memberId=12345 --sensitive-input memberId \
  --evidence-dir evidence/discovery-run
```

`--target-url` and `--entry-route` are genuine inputs, not environment
defaults dressed up as parameters — the loop navigates to `--entry-route`
explicitly and by name (`runDiscovery()` in `src/discovery/loop.ts`)
rather than assuming wherever the login flow's own redirect happens to
land. Both default sensibly (`TARGET_APP_BASE_URL` env var or
`http://localhost:4173`; `/member-search`) if omitted. On git-bash/MSYS,
prefix with `MSYS_NO_PATHCONV=1` or the leading `/` in `--entry-route`
gets mangled into a Windows path (same issue as `--route` on
`npm run inspect`, see above).

Note the goal uses the same `{{inputs.NAME}}` placeholder convention as a
`type` action -- the loop refuses to launch at all if a goal contains a
raw sensitive value verbatim (see `docs/slices.md`'s Slice 6 entry for
why that check exists: it's there because a raw value leaked once).
`evidence/discovery-run/trace.jsonl` records every observation, decision,
and action; `summary.json` has the final result. Prints `mode=DISCOVERY`
and completes in a handful of steps against the live app -- no
pre-existing artifact involved.

## Discovery-time handoff (3.6 gap closure)

"The agent is stuck during discovery" is one of the brief's own three
named handoff triggers. `--wait-for-handoff` gives discovery the exact
same suspend/resume mechanism replay's escalation already uses --
`intervention.json`, `session-handle.json`, a live CDP session an
operator console can attach to -- instead of just failing closed with
the browser already gone.

```bash
# Terminal 1: a near-zero --timeout-ms forces an immediate, deterministic
# TIMEOUT escalation (real model/network calls would otherwise make
# "when exactly does it get stuck" non-deterministic to demo).
MSYS_NO_PATHCONV=1 npm run discover -- \
  --goal "Look up member {{inputs.memberId}} and read their current savings balance" \
  --target-url http://localhost:4173 --entry-route /member-search \
  --input memberId=12345 --sensitive-input memberId --timeout-ms 100 \
  --wait-for-handoff --resume-timeout-ms 90000 \
  --evidence-dir evidence/discovery-handoff-demo

# Terminal 2: --capability/--version are optional here -- there IS no
# capability yet, that's the entire point of discovery. Without one, the
# console shows "Discovery goal" instead of "Capability" and offers only
# the generic action below (no capability-specific quick-action button).
npm run operator -- --evidence-dir evidence/discovery-handoff-demo
```

Open `http://localhost:4500`. There's nothing capability-specific to
click yet, so just Resume (with a note) -- automation picks up with a
fresh time budget and continues the SAME live session from wherever it
left off. If the timeout is small enough that a resume immediately
re-expires (an LLM round-trip genuinely takes longer than 100ms), just
resume again; each cycle is a real, independent
`INTERVENTION_REQUESTED -> CONTROL_TRANSFERRED -> HUMAN_ACTION ->
CONTROL_TRANSFERRED -> AUTOMATION_RESUMED` sequence in `events.jsonl`,
and the run completes the original goal for real once it clears --
`status: "success"` with the correct balance, not a canned response.

The console's `/act-by-text` endpoint is the generic quick-action a
discovery-time intervention needs (no `targetRegistry` to resolve a
`targetPurpose` against): it clicks by raw visible text instead, the
same last-resort mechanism the targeting ladder's own `visible_text`
rung already uses. It works for a replay intervention too -- try it
against the risk-class demo above instead of the capability-specific
button:

```bash
curl -X POST http://localhost:4500/act-by-text --data-urlencode "text=Confirm Close"
```

## Compiling and verifying a discovered capability

Turns a discovery trace into a versioned artifact, then proves it by
replaying on an input discovery never saw:

```bash
# Trace -> draft artifact (one LLM classification call)
npm run compile -- --trace-dir evidence/discovery-run \
  --capability-id member.read-savings-balance --version 2 \
  --output capabilities/member.read-savings-balance.v2.json \
  --replay-input memberId=12345

# The verification gate: memberId=67890 was never used during discovery
# or compilation. Success here is the mechanical proof the compiler
# parameterized memberId rather than transcribing "12345".
npm run replay -- --capability member.read-savings-balance --version 2 \
  --input memberId=67890 --evidence-dir evidence/verify-compiled

# DRAFT -> VERIFIED, only after you've confirmed the replay above yourself
npm run promote -- --path capabilities/member.read-savings-balance.v2.json
```

Each writes `run-state.json`, `events.jsonl`, `result.json`, and a
screenshot into its `--evidence-dir`. `memberId` is declared `sensitive`
in the artifact; every one of those files is redacted at capture, not
scrubbed afterward -- verified by grepping the evidence directories for
the raw value.

### Emitting the artifact automatically, in one command

The two-step flow above (`discover` then a separate `compile`) still
requires the operator to remember to run `compile` at all. `--auto-compile`
closes that: a successful discovery run is compiled into a draft artifact
in the *same* command, no separate step -- this is exactly the "Demo
path" command at the top of this README.

`--output-schema` points at a JSON file declaring the *desired* outputs
and their fields (name, type, a column-header hint, a `semanticPurpose` for
classification) -- see `output-schemas/member-read-savings-balance.json`.
This is what lets the compiler group related fields into one structured
output (below) instead of one flat field per fact. `--auto-compile`
automates only artifact emission: verification (replay on an input the
run never saw) and promotion stay separate, deliberate commands --
"verified" means a human or process confirmed the capability generalizes,
not merely that the compiler didn't crash on the run that produced it.
`capabilities/member.read-savings-balance.v3.json` in this repo was
produced this way, then verified on `memberId=67890` and promoted exactly
as in the manual flow above.

### Structured outputs, not flat fields

`v2`/`v3`'s `outputs.account` is a real nested value, not three
independent flat outputs the caller has to know go together:

```json
{ "account": { "balance": "9310.25", "currency": "USD", "accountId": "SAV-40988" } }
```

The schema (`OutputShape` in `src/contracts/capability.ts`) is recursive
-- `scalar | {type:'object', properties} | {type:'array', items}` -- and
each shape has its own producer requirement, enforced by
`OutputDefSchema`'s `superRefine`: a scalar needs one `sourceStepId`; an
object needs `sourceStepsByProperty` naming a step for *every* declared
property; an array is representable in the schema (a reviewer can see one
declared) but `assembleOutput()` deliberately throws rather than guess at
replay time -- there's no producer for it yet, and a schema is allowed to
describe more than the runtime currently fulfills as long as it says so
at the point of failure rather than emitting something silently wrong.

## Capability catalog over real MCP (vendor-neutral)

The capability catalog (Slice 9) is exposed two ways: through the
Anthropic SDK directly (`npm run catalog:demo`), and as a genuine MCP
server (`@modelcontextprotocol/sdk`, real `tools/list`/`tools/call`
JSON-RPC over HTTP) so any MCP-compatible client can use it, not just
Claude via the Anthropic SDK.

```bash
npm run mcp -- --port 4600
```

**Browser test UI** — open `http://localhost:4600/` — lists every tool
from a real `tools/list` call and gives you a form to `tools/call` each
one, showing the raw JSON-RPC response.

**Postman-style curl**, hitting the identical endpoint the UI uses:

```bash
curl -s -X POST http://localhost:4600/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

curl -s -X POST http://localhost:4600/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"member_read-savings-balance_v2","arguments":{"memberId":"67890"}}}'
```

Only `v2` (promoted to `verified` in Slice 7) appears in the catalog —
`v1` is still `draft` and is excluded by `loadCatalog()` on purpose.

## Stretch: multi-tenant reuse

The same verified `v2` artifact, recorded against tenant A, replayed
against tenant B's differently-labeled instance of the same vendor
product via a `TenantBinding` -- no re-recording. In one terminal:

```bash
TENANT_VARIANT=B PORT=4174 npm run target-app
```

In another:
```bash
npm run replay:tenant -- --capability member.read-savings-balance --version 2 \
  --binding tenants/credit-union-b.json --input memberId=12345 \
  --evidence-dir evidence/replay-tenant-b
```

Variant B renders "Customer Number" instead of "Member ID" and
"Products" instead of "Accounts" -- confirm with `curl` if you like
before running the replay. `tenants/credit-union-b.json` overrides only
those two `targetRegistry` entries; everything else (steps, checkpoint,
the other two extraction targets) is untouched from the base artifact.

## Stretch: capability catalog (Anthropic SDK)

Every `verified`/`approved` artifact becomes an Anthropic tool
definition, generated from the same Zod schema that validates the
artifact file. With the target app running:

```bash
npm run catalog:demo -- --request "What is member 12345's current savings balance?"
```

Claude sees the catalog (only `v2` -- `v1` is still `draft` and is
excluded), picks the matching capability, supplies typed arguments, and
the deterministic replay engine (not the model) executes it.

## Stretch: route canonicalization

The compiler derives `scope.allowedRoutes` from routes actually visited
during its own live replay rather than a hand-typed list — recompile and
see for yourself:

```bash
npm run compile -- --trace-dir evidence/discovery-run \
  --capability-id member.read-savings-balance --version 2 \
  --output capabilities/member.read-savings-balance.v2.json \
  --replay-input memberId=12345
```

Look at the printed `Derived scope.allowedRoutes` line, or the
`scope.allowedRoutes` field in the written JSON: `/member/12345/accounts`
became `/member/:memberId/accounts` mechanically, not hand-typed.
Recompiling resets the artifact to `draft` — re-run the verification gate
and `npm run promote` afterward (see the compiling section above) if you
want it `verified` again.

## Stretch: multi-run stability

```bash
npm run stability -- --capability member.read-savings-balance --version 2 \
  --input memberId=67890 --runs 5 --evidence-dir evidence/stability-v2
```

Replays the artifact N times and reports success rate plus per-step rung
consistency — a step resolving via a different candidate strategy across
otherwise-identical runs is a real drift signal even when every run
individually succeeds. `evidence/stability-v2/summary.json` has the
aggregate; `evidence/stability-v2/run-N/` has each individual run's full
evidence.

## What's here so far

```
src/contracts/    Zod schemas — the single source of truth for artifact
                   shape, execution results, run state, policy decisions,
                   intervention requests, and evidence events. Everything
                   downstream (adapter, replay engine, compiler) types
                   against this package.
capabilities/     Versioned capability artifacts. member.read-savings-balance.v1.json
                   is hand-authored (per the plan: replay is built and proven
                   against a hand-written artifact before any LLM is involved).
scripts/          validate-artifacts.ts (schema gate) and emit-json-schema.ts
                   (Zod -> JSON Schema, later reused as the agent tool-call
                   definition for the capability catalog).
tests/            Vitest suite over the contracts, including negative cases
                   (rejects PAUSED as a run status, rejects free-text
                   conditions, rejects an out-of-vocabulary semantic purpose,
                   flags a targetRegistry referential-integrity break).
target-app/       The local legacy-style banking demo automation runs
                   against: login, member search, member detail, accounts.
                   Table layout, no test IDs, a member-ID field with no
                   label association (forces the adapter's fallback
                   ladder to actually fire), account fields rendered
                   inside a named iframe (a real frame-traversal case).
docs/capability.schema.json  Generated JSON Schema (do not hand-edit —
                   regenerate with `npm run emit:jsonschema`).
```

## Running the Slice 2 gate (adapter + policy, no replay engine yet)

With the target app running in another terminal:
```bash
npm run smoke:adapter
```
Drives the real Playwright adapter through the artifact's step sequence
against the live app -- login, search, navigate, extract, checkpoint --
with zero LLM and zero replay engine involved. Confirms an out-of-allowlist
route is denied before a browser even launches, and that the member-ID
field's targeting genuinely falls through from role_and_name to the
associated_label heuristic (the real markup has no label association).
Screenshot evidence lands in `tmp/` (gitignored dev scratch -- curated
`/evidence/` directories start with Slice 3's replay engine).

## Design write-up

[`REPORT.md`](REPORT.md) covers architecture, the artifact schema,
determinism and error handling, heterogeneity and multi-tenant reuse,
escalation and handoff, safety, and what was deliberately cut — in that
order, per the take-home's required headings.
[`docs/phase-2-scale.md`](docs/phase-2-scale.md) is the multi-tenant/scale
design referenced from §4 — explicitly not built, per the brief's own
guidance that designing for scale is valuable and building the
infrastructure prematurely is not.
