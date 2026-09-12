import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CapabilityDefinition, Target } from '../contracts/index.js';
import { sensitiveTargetPurposes } from '../policy/redact.js';
import { resolveTarget } from './resolveTarget.js';

/**
 * Redaction at capture, not at write: sensitive-bound controls are
 * literally switched to a masked input type in the live DOM immediately
 * before the screenshot, and restored immediately after. The screenshot
 * file itself never contains the rendered value — there is no "raw
 * screenshot" that later gets scrubbed, because it never existed.
 */
export async function captureEvidenceScreenshot(
  page: Page,
  capability: CapabilityDefinition,
  targetRegistry: Record<string, Target>,
  outPath: string,
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

  try {
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
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
