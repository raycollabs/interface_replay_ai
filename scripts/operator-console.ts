#!/usr/bin/env tsx
/**
 * The minimal-but-real operator console (Slice 5). Deliberately bare —
 * server-rendered HTML, refresh-based, no JS framework — per the brief's
 * own scope note: "a full real-time co-browsing operator console is out
 * of scope... mock the operator UI if needed, but make the handoff
 * mechanism and the control-transfer model real."
 *
 * What's real: this is a SEPARATE OS process from the replay worker. It
 * attaches to the exact same live browser via the cdpEndpoint the worker
 * wrote to session-handle.json, acts on the SAME page, and hands control
 * back by flipping intervention.json's status to 'resolved' -- the one
 * field the worker is polling for. Nothing here is simulated.
 *
 * Usage:
 *   npm run operator -- --evidence-dir evidence/replay-handoff \
 *     --capability member.read-savings-balance --version 1
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CapabilityDefinitionSchema, type RunEvent } from '../src/contracts/index.js';
import { resolveTarget } from '../src/surface/resolveTarget.js';
import { readIntervention, readSessionHandle, writeIntervention } from '../src/session/broker.js';
import { appendEvent } from '../src/replay/runStore.js';
import { randomUUID } from 'node:crypto';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) args[argv[i]!.slice(2)] = argv[++i]!;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const evidenceDir = args['evidence-dir'];
if (!evidenceDir || !args.capability || !args.version) {
  console.error('Usage: operator-console --evidence-dir <path> --capability <id> --version <n> [--port 4500]');
  process.exit(1);
}

const artifactPath = fileURLToPath(new URL(`../capabilities/${args.capability}.v${args.version}.json`, import.meta.url));
const capability = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf-8')));
const OPERATOR_ID = 'operator-1'; // hardcoded demo identity -- Slice 8's phase-2 doc covers real tenant-scoped operator auth

/**
 * Fresh CDP connection per request -- deliberately never closed here.
 * `connectOverCDP` is what actually shares contexts/pages across
 * simultaneous independent clients (verified directly; Playwright's own
 * `connect()` to a `launchServer()` browser does NOT -- see the Slice 5
 * commit message and src/surface/adapter.ts's comment). Not calling
 * close() on the returned Browser avoids any ambiguity about whether
 * that would also tear down the shared browser process; a short-lived
 * Express request handler leaking one CDP connection is harmless.
 */
async function attach(cdpEndpoint: string) {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) throw new Error('Connected via CDP but no context/page appeared -- is the worker session still alive?');
  return { page };
}

function logHumanAction(runId: string, data: Record<string, unknown>): void {
  const event: RunEvent = {
    eventId: randomUUID(),
    runId,
    type: 'HUMAN_ACTION',
    timestamp: new Date().toISOString(),
    data,
  };
  appendEvent(evidenceDir!, event);
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/', async (_req, res) => {
  const intervention = readIntervention(evidenceDir!);
  if (!intervention) {
    return res.send('<h1>Operator Console</h1><p>No intervention on file for this evidence directory yet.</p>');
  }
  if (intervention.status === 'resolved') {
    return res.send(`<h1>Operator Console</h1><p>Intervention ${intervention.interventionId} already resolved. Nothing to do.</p>`);
  }

  // Viewing IS claiming, for this minimal console -- one operator, one run.
  if (intervention.status === 'open') {
    intervention.status = 'claimed';
    intervention.claimedBy = OPERATOR_ID;
    writeIntervention(evidenceDir!, intervention);
  }

  const session = readSessionHandle(evidenceDir!);
  let screenshotNote = '';
  if (session) {
    const { page } = await attach(session.cdpEndpoint);
    await page.screenshot({ path: `${evidenceDir}/operator-view.png` }).catch(() => {});
    screenshotNote = `Live screenshot captured to ${evidenceDir}/operator-view.png (open it alongside this page).`;
  }

  res.send(`
    <h1>Operator Console -- Intervention ${intervention.interventionId}</h1>
    <p><b>Capability:</b> ${intervention.capabilityId}</p>
    <p><b>Stuck at step:</b> ${intervention.stepId}</p>
    <p><b>Reason:</b> ${intervention.reasonCode}</p>
    <p><b>Why it stopped:</b> ${intervention.explanation}</p>
    <p>${screenshotNote}</p>
    <hr/>
    <h2>Act on the live session</h2>
    <form method="post" action="/act">
      <button type="submit" name="targetPurpose" value="unresolvable notice acknowledgment">
        Click: "Acknowledge and escalate"
      </button>
    </form>
    <hr/>
    <h2>Resume automation</h2>
    <form method="post" action="/resume">
      <label>Operator note: <input type="text" name="note" size="60" placeholder="Describe what you did and why" /></label>
      <button type="submit">Resume</button>
    </form>
  `);
});

app.post('/act', async (req, res) => {
  const session = readSessionHandle(evidenceDir!);
  const intervention = readIntervention(evidenceDir!);
  if (!session || !intervention) return res.status(400).send('No active session/intervention.');

  const targetPurpose = String(req.body?.targetPurpose ?? '');
  const target = capability.targetRegistry[targetPurpose];
  if (!target) return res.status(400).send(`Unknown target purpose "${targetPurpose}".`);

  const { page } = await attach(session.cdpEndpoint);
  const resolution = await resolveTarget(page, target);
  if (resolution.outcome !== 'resolved') {
    return res.status(409).send(`Could not resolve "${targetPurpose}": ${resolution.outcome}`);
  }
  await resolution.locator.click();
  await page.screenshot({ path: `${evidenceDir}/operator-after-action.png` }).catch(() => {});

  logHumanAction(intervention.runId, { operatorId: OPERATOR_ID, action: 'click', targetPurpose });

  res.send(`<p>Clicked "${targetPurpose}". <a href="/">Back</a></p>`);
});

app.post('/resume', (req, res) => {
  const intervention = readIntervention(evidenceDir!);
  if (!intervention) return res.status(400).send('No active intervention.');

  intervention.status = 'resolved';
  intervention.resolutionNote = String(req.body?.note ?? '(no note provided)');
  writeIntervention(evidenceDir!, intervention);

  logHumanAction(intervention.runId, { operatorId: OPERATOR_ID, action: 'resume', note: intervention.resolutionNote });

  res.send('<p>Resume signaled. The replay worker will pick this up on its next poll. <a href="/">Back</a></p>');
});

const port = Number(args.port ?? 4500);
app.listen(port, () => {
  console.log(`Operator console listening on http://localhost:${port} (evidence-dir=${evidenceDir})`);
});
