import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CapabilityDefinition, Target } from '../contracts/index.js';
import { sensitiveTargetPurposes } from '../policy/redact.js';
import { resolveTarget } from './resolveTarget.js';

/**
 * Sweeps every text node in one frame's document, replacing any occurrence
 * of a raw sensitive value with `[REDACTED]` in place, and returns enough
 * information to undo it afterward. Passed as a plain string to
 * frame.evaluate() (not a real function reference) -- tsx/esbuild's
 * keepNames transform breaks named nested functions inside an evaluate
 * callback (see src/discovery/setOfMarks.ts's markFrameScript for the same
 * fix, hit once already in this project).
 *
 * 3.4 gap closure: the existing per-control masking below only covers
 * `<input>` elements a sensitive value was TYPED into. It does nothing for
 * a value the APP ITSELF echoes back as plain rendered text (a "no such
 * member 99999" banner) -- confirmed live by pulling an actual persisted
 * screenshot and finding the raw memberId baked into the pixels. This
 * sweep catches that case: it doesn't care what element the text sits in,
 * only whether the value is visible anywhere in the rendered DOM.
 */
const REDACT_TEXT_SCRIPT = `
(function(values) {
  var restores = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var node;
  while ((node = walker.nextNode())) {
    var original = node.nodeValue;
    if (!original) continue;
    var replaced = original;
    var changed = false;
    for (var i = 0; i < values.length; i++) {
      if (values[i] && replaced.indexOf(values[i]) !== -1) {
        replaced = replaced.split(values[i]).join('[REDACTED]');
        changed = true;
      }
    }
    if (changed) {
      node.nodeValue = replaced;
      restores.push([node, original]);
    }
  }
  window.__evidenceTextRestores = (window.__evidenceTextRestores || []).concat(restores);
})
`;

const RESTORE_TEXT_SCRIPT = `
(function() {
  var restores = window.__evidenceTextRestores || [];
  for (var i = 0; i < restores.length; i++) {
    restores[i][0].nodeValue = restores[i][1];
  }
  window.__evidenceTextRestores = [];
})
`;

async function redactSensitiveTextAcrossFrames(page: Page, sensitiveValues: string[]): Promise<void> {
  const values = sensitiveValues.filter((v) => v && v.length > 0);
  if (values.length === 0) return;
  for (const frame of page.frames()) {
    await frame.evaluate(`(${REDACT_TEXT_SCRIPT})(${JSON.stringify(values)})`).catch(() => {});
  }
}

async function restoreSensitiveTextAcrossFrames(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame.evaluate(`(${RESTORE_TEXT_SCRIPT})()`).catch(() => {});
  }
}

/**
 * Redaction at capture, not at write: sensitive-bound controls are
 * literally switched to a masked input type in the live DOM immediately
 * before the screenshot, and any raw sensitive value rendered anywhere as
 * plain text is swapped for `[REDACTED]` too -- both restored immediately
 * after. The screenshot file itself never contains the rendered value —
 * there is no "raw screenshot" that later gets scrubbed, because it never
 * existed.
 */
export async function captureEvidenceScreenshot(
  page: Page,
  capability: CapabilityDefinition,
  targetRegistry: Record<string, Target>,
  outPath: string,
  sensitiveValues: string[] = [],
): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });

  const purposes = sensitiveTargetPurposes(capability);
  const maskedLocators: Awaited<ReturnType<typeof resolveTarget>>[] = [];

  for (const purpose of purposes) {
    const target = targetRegistry[purpose];
    if (!target) continue;
    const resolution = await resolveTarget(page, target);
    maskedLocators.push(resolution);
  }

  const masked = maskedLocators.filter((r) => r.outcome === 'resolved');
  for (const r of masked) {
    if (r.outcome !== 'resolved') continue;
    await r.locator
      .evaluate((el) => {
        if (el instanceof HTMLInputElement) {
          el.dataset.evidenceOrigType = el.type;
          el.type = 'password';
        }
      })
      .catch(() => {});
  }

  await redactSensitiveTextAcrossFrames(page, sensitiveValues);

  try {
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await restoreSensitiveTextAcrossFrames(page);
    for (const r of masked) {
      if (r.outcome !== 'resolved') continue;
      await r.locator
        .evaluate((el) => {
          if (el instanceof HTMLInputElement && el.dataset.evidenceOrigType) {
            el.type = el.dataset.evidenceOrigType;
            delete el.dataset.evidenceOrigType;
          }
        })
        .catch(() => {});
    }
  }
}
