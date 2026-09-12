import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservedControl } from './setOfMarks.js';

/**
 * The discovery trace is NOT the artifact -- kept as a separate,
 * append-only record of what happened during exploration (observation,
 * model decision, policy decision, action, result). Slice 7's compiler
 * reads this to produce a CapabilityDefinition; nothing downstream of
 * discovery ever replays this trace directly.
 *
 * `observation.controls` carries the FULL set-of-marks inventory for
 * that step (role/accessibleName/framePath per mark), not just a count
 * -- this is what lets the compiler later re-derive a target strategy
 * for whichever mark the model acted on, without needing vision or a
 * second guess at what "mark 7" was.
 */
export interface TraceEntry {
  step: number;
  timestamp: string;
  observation: { screenshotPath: string; controls: ObservedControl[] };
  /** Short operational summary only -- per the "don't persist chain-of-
   *  thought" rule (same one the replay engine's evidence follows). */
  modelRationale: string;
  toolName: string;
  toolInput: unknown;
  outcome: unknown;
}

export function ensureTraceDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function appendTraceEntry(dir: string, entry: TraceEntry): void {
  ensureTraceDir(dir);
  appendFileSync(join(dir, 'trace.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
}

export function writeTraceSummary(dir: string, summary: unknown): void {
  ensureTraceDir(dir);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8');
}
