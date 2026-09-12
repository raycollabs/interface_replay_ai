# interface_replay_ai

A computer-use automation system: an LLM discovers how to complete a goal in
a live legacy-style banking UI, the successful run is compiled into a typed,
versioned **capability artifact**, and a deterministic runtime replays that
artifact in production with no LLM in the decision loop — escalating to a
human when it can't safely proceed.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how an AI agent invokes it in production.

Build status: **all 9 slices complete**, including both stretch goals
(multi-tenant resolution, capability catalog). See
[`docs/slices.md`](docs/slices.md) for the full plan, and
[`REPORT.md`](REPORT.md) for the design write-up.

**Running without an API key:** `npm run build`, `npm test`,
`npm run validate:artifacts`, the target app, and every `npm run replay`
/ `npm run smoke:adapter` / `npm run operator` command below work with
only the local target app running — no internet access or API key
needed. Only `npm run discover` and `npm run compile` call the Anthropic
API and need `ANTHROPIC_API_KEY`.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run build              # type-check + compile
npm test                   # contract schema tests
npm run validate:artifacts # validate every artifact in /capabilities against the schema
npm run emit:jsonschema    # regenerate capabilities/schema.json from the Zod source of truth
```

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` if you want to run
discovery or compilation (see below) — nothing else needs it.

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

## Running the target app

```bash
npm run target-app
# Target app listening on http://localhost:4173
# Login with username="operator" password="demo-pass-1234"  (synthetic, not a real credential)
```

Then in a browser: `/login` -> `/member-search` -> search `12345` -> `/member/12345` -> "Accounts" link -> savings balance renders inside the accounts iframe. Any other member ID currently 404s with a not-found banner (business-outcome handling for this is wired up in Slice 4).

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

## Demo path

Deterministic replay (no LLM — the CLI prints `llmCalls=0` because there is
structurally no code path in the replay engine that could make it anything
else, see `tests/replay/no-llm-import.test.ts`). With the target app
running in another terminal:

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
```

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

## Discovery (genuine LLM-driven run)

Requires `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`). With the
target app running:

```bash
npm run discover -- \
  --goal "Look up member {{inputs.memberId}} and read their current savings balance" \
  --input memberId=12345 --sensitive-input memberId \
  --evidence-dir evidence/discovery-run
```

Note the goal uses the same `{{inputs.NAME}}` placeholder convention as a
`type` action -- the loop refuses to launch at all if a goal contains a
raw sensitive value verbatim (see `docs/slices.md`'s Slice 6 entry for
why that check exists: it's there because a raw value leaked once).
`evidence/discovery-run/trace.jsonl` records every observation, decision,
and action; `summary.json` has the final result. Prints `mode=DISCOVERY`
and completes in a handful of steps against the live app -- no
pre-existing artifact involved.

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

## Stretch: capability catalog

Every `verified`/`approved` artifact becomes an Anthropic tool
definition, generated from the same Zod schema that validates the
artifact file. With the target app running:

```bash
npm run catalog:demo -- --request "What is member 12345's current savings balance?"
```

Claude sees the catalog (only `v2` -- `v1` is still `draft` and is
excluded), picks the matching capability, supplies typed arguments, and
the deterministic replay engine (not the model) executes it.

## Design write-up

[`REPORT.md`](REPORT.md) covers architecture, the artifact schema,
determinism and error handling, heterogeneity and multi-tenant reuse,
escalation and handoff, safety, and what was deliberately cut — in that
order, per the take-home's required headings.
[`docs/phase-2-scale.md`](docs/phase-2-scale.md) is the multi-tenant/scale
design referenced from §4 — explicitly not built, per the brief's own
guidance that designing for scale is valuable and building the
infrastructure prematurely is not.
