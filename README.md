# interface_replay_ai

A computer-use automation system: an LLM discovers how to complete a goal in
a live legacy-style banking UI, the successful run is compiled into a typed,
versioned **capability artifact**, and a deterministic runtime replays that
artifact in production with no LLM in the decision loop — escalating to a
human when it can't safely proceed.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how an AI agent invokes it in production.

Build status: **Slice 0 of 9 complete** (contracts). See [`docs/slices.md`](docs/slices.md)
for the full plan and current progress, and `REPORT.md` (added from Slice 5)
for the design write-up.

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
                   conditions, rejects an out-of-vocabulary semantic purpose).
```

## Demo path (grows per slice)

Once Slice 3 lands:
```bash
npm run replay -- --capability member.read-savings-balance --version 1 --input memberId=12345
```

Once Slice 6 lands:
```bash
npm run discover -- --goal "Look up member 12345 and read their savings balance" --target local-bank
```

Evidence from both discovery and replay runs lands in `/evidence/`.

## Design write-up

`REPORT.md` (added from Slice 5) covers architecture, the artifact schema,
determinism and error handling, heterogeneity and multi-tenant reuse,
escalation and handoff, safety, and what was deliberately cut — in that
order, per the take-home's required headings.
