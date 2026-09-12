import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent, RunState } from '../contracts/index.js';

/**
 * Durable run state, written after every step boundary -- what makes
 * replay a suspendable state machine rather than a blocking function call
 * (see RunState's doc comment for why). For this project's scope, a run's
 * evidence directory IS its persistence location: `evidenceDir` doubles
 * as the run's durable-state identifier (resume, in Slice 5, is keyed by
 * `--evidence-dir` rather than a separate run registry). That's a
 * deliberate simplification for a single-process, single-tenant take-home
 * -- a production system would key runs in a database and evidence
 * separately in object storage (see docs/phase-2-scale.md), but the
 * write-after-every-step-boundary discipline this module enforces is the
 * part that has to be right regardless of where the bytes end up.
 */
export function ensureEvidenceDir(evidenceDir: string): void {
  mkdirSync(evidenceDir, { recursive: true });
}

export function saveRunState(evidenceDir: string, state: RunState): void {
  ensureEvidenceDir(evidenceDir);
  writeFileSync(join(evidenceDir, 'run-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function loadRunState(evidenceDir: string): RunState {
  const raw = readFileSync(join(evidenceDir, 'run-state.json'), 'utf-8');
  return JSON.parse(raw) as RunState;
}

export function runStateExists(evidenceDir: string): boolean {
  return existsSync(join(evidenceDir, 'run-state.json'));
}

export function appendEvent(evidenceDir: string, event: RunEvent): void {
  ensureEvidenceDir(evidenceDir);
  appendFileSync(join(evidenceDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
}

export function saveResult(evidenceDir: string, result: unknown): void {
  ensureEvidenceDir(evidenceDir);
  writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf-8');
}
