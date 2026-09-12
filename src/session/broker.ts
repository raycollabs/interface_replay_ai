import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InterventionRequest } from '../contracts/index.js';

/**
 * The session broker's persistence layer, scoped to one run's evidence
 * directory. A production SessionBroker would key runs across a shared
 * store reachable by any worker/operator process (see
 * docs/phase-2-scale.md); for this project's single-run demo, the
 * evidence directory itself is the shared location both processes look
 * at -- the replay worker and the operator console are still genuinely
 * separate OS processes, they just agree on a path instead of a database.
 *
 * `intervention.json` is the seam: whichever field the worker is polling
 * (`status === 'resolved'`) is exactly the field the operator console
 * writes on resume. Neither process needs to know anything about the
 * other beyond that file.
 */
export function interventionPath(evidenceDir: string): string {
  return join(evidenceDir, 'intervention.json');
}

export function writeIntervention(evidenceDir: string, intervention: InterventionRequest): void {
  writeFileSync(interventionPath(evidenceDir), JSON.stringify(intervention, null, 2) + '\n', 'utf-8');
}

export function readIntervention(evidenceDir: string): InterventionRequest | null {
  const path = interventionPath(evidenceDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as InterventionRequest;
}

/** Session info a second process needs to attach to the SAME live
 *  browser: the CDP endpoint (see src/surface/adapter.ts for why CDP,
 *  not Playwright's own connect() protocol), written once the run
 *  suspends. Deliberately separate from run-state.json -- this is
 *  connection info, not run state, and a production system would keep it
 *  somewhere shorter-lived / access-controlled differently (see
 *  docs/phase-2-scale.md's SessionBroker section). */
export interface SessionHandle {
  sessionId: string;
  cdpEndpoint: string;
}

export function sessionHandlePath(evidenceDir: string): string {
  return join(evidenceDir, 'session-handle.json');
}

export function writeSessionHandle(evidenceDir: string, handle: SessionHandle): void {
  writeFileSync(sessionHandlePath(evidenceDir), JSON.stringify(handle, null, 2) + '\n', 'utf-8');
}

export function readSessionHandle(evidenceDir: string): SessionHandle | null {
  const path = sessionHandlePath(evidenceDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as SessionHandle;
}

/** Polls until the intervention is resolved (operator hit Resume) or the
 *  timeout elapses. This is the worker's side of the handoff -- it does
 *  nothing else while suspended; it does not hold the process open by
 *  busy-waiting on the browser, only on this one small file. */
export async function waitForResolution(evidenceDir: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const intervention = readIntervention(evidenceDir);
    if (intervention?.status === 'resolved') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
