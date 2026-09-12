#!/usr/bin/env tsx
/**
 * A human-verification tool, not part of the take-home's own pipeline:
 * logs into the target app, navigates to a given route, and prints
 * EVERY interactive control (reusing the same set-of-marks scan
 * discovery uses) plus the raw visible text of every frame (which is
 * what catches non-interactive data -- a table cell holding a balance
 * isn't "interactive", so it never gets a mark, but it's exactly the
 * kind of thing you want to sanity-check after a replay run). Also
 * saves a full-page screenshot so you can look at it directly instead
 * of trusting a JSON dump.
 *
 * Usage:
 *   npm run inspect -- --route /member/12345/accounts
 *   npm run inspect -- --route /member/33333/accounts --screenshot tmp/stuck.png
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { PlaywrightSurfaceAdapter } from '../src/surface/adapter.js';
import { observeWithMarks } from '../src/discovery/setOfMarks.js';

function loadDotEnv(): void {
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (!(trimmed.slice(0, eq).trim() in process.env)) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadDotEnv();

function parseArgs(argv: string[]) {
  const args: { route?: string; screenshot?: string; headless?: boolean } = { headless: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--route') args.route = argv[++i];
    else if (argv[i] === '--screenshot') args.screenshot = argv[++i];
    else if (argv[i] === '--headed') args.headless = false;
  }
  return args;
}

async function loginToTargetApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=username]').fill(process.env.TARGET_APP_USERNAME ?? 'operator');
  await page.locator('input[name=password]').fill(process.env.TARGET_APP_PASSWORD ?? 'demo-pass-1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/member-search');
}

/** Visible text per frame -- what catches plain, non-interactive data
 *  (a table cell holding a balance) that the interactive-only
 *  set-of-marks scan never marks. */
async function textByFrame(page: Page): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  result['(top)'] = (await page.mainFrame().evaluate(() => document.body.innerText)).trim();
  for (const child of page.mainFrame().childFrames()) {
    const name = child.name();
    if (!name) continue;
    result[name] = (await child.evaluate(() => document.body.innerText).catch(() => '(could not read)')).trim();
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.route) {
    console.error('Usage: inspect-page --route </some/path> [--screenshot <path>] [--headed]');
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';
  const screenshotPath = args.screenshot ?? `tmp/inspect-${args.route.replace(/[^a-zA-Z0-9]+/g, '-')}.png`;

  const adapter = new PlaywrightSurfaceAdapter(baseUrl, { headless: args.headless });
  await adapter.launch();
  const page = adapter.getPage();

  try {
    await loginToTargetApp(page, baseUrl);
    await page.goto(new URL(args.route, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    const { controls } = await observeWithMarks(page, screenshotPath);
    const text = await textByFrame(page);

    console.log(`URL: ${page.url()}`);
    console.log(`\n=== Interactive controls (${controls.length}) ===`);
    for (const c of controls) {
      const frame = c.framePath.length ? ` [frame: ${c.framePath.join('>')}]` : '';
      console.log(`  #${c.mark}  <${c.tag}> role=${c.role} name="${c.accessibleName}"${frame}`);
    }

    console.log(`\n=== Visible text by frame ===`);
    for (const [frame, content] of Object.entries(text)) {
      console.log(`--- ${frame} ---`);
      console.log(content || '(empty)');
    }

    console.log(`\nScreenshot: ${screenshotPath}`);
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
