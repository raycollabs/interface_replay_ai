# Evidence index

Everything in this directory is real, captured output from actually
running this system — no directory here was hand-written or simulated.
See the root [`README.md`](../README.md) for the exact commands that
produced each one; this file is a map of what's here and why, for the
specific deliverable ask ("a demonstration of the end-to-end flow in
`/evidence/` — a saved example artifact plus logs from both a discovery
run and a replay run... ideally including one replay that hits an error
or exceptional state").

## The canonical example (start here)

One capability, one continuous lineage, satisfying the deliverable's
three parts directly:

| What | Where |
|---|---|
| The saved example artifact | [`../capabilities/member.read-savings-balance.v3.json`](../capabilities/member.read-savings-balance.v3.json) — `status: "verified"`; `provenance.discoveryRunId` points at the discovery run below |
| Logs from a discovery run | [`discovery-run-autocompile/`](discovery-run-autocompile/) — `trace.jsonl` (every observation + decision), `summary.json` (the real result), `step-*.png` (screenshots) from the genuine `claude-sonnet-5` run that produced the artifact above |
| Logs from a replay run | [`verify-autocompile/`](verify-autocompile/) — `events.jsonl`, `run-state.json`, `result.json`, `success.png` from replaying that same artifact on `memberId=67890`, an input the discovery run never saw |

`README.md`'s "Demo path" and "The end-to-end thread" sections walk
through exactly this pair, command by command.

## A replay hitting an error or exceptional state

The deliverable asks for at least one; this repo has seven, each a
genuinely distinct condition (not seven copies of the same demo):

| Directory | Condition | Result |
|---|---|---|
| [`replay-failure/`](replay-failure/) | Bad input (`memberId=abc`, fails the declared pattern) | `status: "failure"`, `code: "INPUT_CONTRACT_VIOLATION"` — rejected before anything touches the surface |
| [`replay-business-outcome/`](replay-business-outcome/) | Not-found result (`memberId=99999`) | `status: "business_outcome"`, `code: "MEMBER_NOT_FOUND"` — a legitimate result, not a crash |
| [`replay-validation-error/`](replay-validation-error/) | A well-formed but app-rejected identifier | `status: "business_outcome"`, `code: "VALIDATION_ERROR"` |
| [`replay-permission-denied/`](replay-permission-denied/) | A real member, permanently access-restricted | `status: "business_outcome"`, `code: "PERMISSION_DENIED"` |
| [`replay-session-expired/`](replay-session-expired/) | Session dropped mid-flow (simulated) | `status: "failure"`, `code: "SESSION_EXPIRED"` |
| [`replay-recovered-dialog/`](replay-recovered-dialog/) | An unexpected dialog (injected fixture) | `status: "success"` after automatic recovery — one `RECOVERY_ATTEMPTED` event |
| [`replay-recovered-slow-load/`](replay-recovered-slow-load/) | A transient slow load (injected fixture) | `status: "success"` after a retry |

Every one of these is redacted at capture — grep any file above for the
member ID used and it reads `[REDACTED]`, never the raw value.

## Human escalation, evidence for both sides of the handoff

| Directory | What it shows |
|---|---|
| [`replay-handoff/`](replay-handoff/) | A capability blocked on an escalate-only interstitial, resolved live via the real operator console (CDP-attached, same session) |
| [`discovery-handoff-demo/`](discovery-handoff-demo/) | The same handoff mechanism, but a *discovery* run getting stuck — resumed four times on the same live session, then genuinely completing the original goal |
| [`replay-close-subaccount-handoff/`](replay-close-subaccount-handoff/), [`replay-close-subaccount-acttext-demo/`](replay-close-subaccount-acttext-demo/) | A `risky_irreversible` mutation carried through a full human-approval cycle to a genuine account deletion |
| [`replay-escalation-unavailable-demo/`](replay-escalation-unavailable-demo/) | The other side of a handoff: nobody responds in time — `status: "failure"`, `code: "ESCALATION_UNAVAILABLE"`, with a screenshot of the state at the moment automation gave up |

## Risk-class handling (mutating_reversible / risky_irreversible)

`replay-create-subaccount-unattended/`, `replay-create-subaccount-attended/`,
`replay-close-subaccount-unattended/`, `replay-close-subaccount-attended/` —
the same two risk classes, blocked or allowed depending on execution mode,
exactly as designed and defended in `REPORT.md` §6 / `ARCHITECTURAL_DECISIONS.md`.

## Multi-tenant, catalog, and stability

`replay-tenant-b/` (the same verified artifact replayed against a
differently-labeled tenant instance, no re-recording), `catalog-invocation/`
and `mcp-invocation/` (a real agent invoking a capability through the
Anthropic-SDK catalog and through genuine MCP `tools/call` respectively),
`stability-v2/` (five repeated replays, aggregated for drift signal).

## Everything else

`discovery-run/`, `discovery-run-explicit-target/`, `replay-success/`,
`verify-compiled/`, `verify-compiled-original-input/` are earlier or
alternate runs from the same build-out, kept as additional evidence
rather than pruned — every directory in this folder is real output from
a real run, none are placeholders.
