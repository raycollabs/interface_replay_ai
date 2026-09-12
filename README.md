# interface_replay_ai

A computer-use automation system: an LLM discovers how to complete a goal in
a live legacy-style banking UI, the successful run is compiled into a typed,
versioned **capability artifact**, and a deterministic runtime replays that
artifact in production with no LLM in the decision loop — escalating to a
human when it can't safely proceed.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how an AI agent invokes it in production.

Build status: **Slice 4 of 9 complete** (contracts, target app, surface
adapter + policy, deterministic replay engine, recoverable conditions). See
[`docs/slices.md`](docs/slices.md) for the full plan and current progress,
and `REPORT.md` (added from Slice 5) for the design write-up.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run build              # type-check + compile
npm test                   # contract schema tests
npm run validate:artifacts # validate every artifact in /capabilities against the schema
npm run emit:jsonschema    # regenerate capabilities/schema.json from the Zod source of truth
```

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` once the discovery
loop (Slice 6) is in place. Nothing before that slice needs an API key.

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

Each writes `run-state.json`, `events.jsonl`, `result.json`, and a
screenshot into its `--evidence-dir`. `memberId` is declared `sensitive`
in the artifact; every one of those files is redacted at capture, not
scrubbed afterward -- verified by grepping the evidence directories for
the raw value.

Once Slice 6 lands:
```bash
npm run discover -- --goal "Look up member 12345 and read their savings balance" --target local-bank
```

## Design write-up

`REPORT.md` (added from Slice 5) covers architecture, the artifact schema,
determinism and error handling, heterogeneity and multi-tenant reuse,
escalation and handoff, safety, and what was deliberately cut — in that
order, per the take-home's required headings.
