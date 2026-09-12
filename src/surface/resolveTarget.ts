import type { Frame, Locator, Page } from 'playwright';
import type { Strategy, Target } from '../contracts/index.js';

export type TargetResolution =
  | { outcome: 'resolved'; locator: Locator; matchedRung: number; matchedStrategyType: Strategy['type'] }
  | { outcome: 'not_resolved' }
  | { outcome: 'ambiguous'; matchedStrategyType: Strategy['type']; count: number }
  | { outcome: 'frame_not_found'; framePath: string[] };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walks a named iframe path down from the page's main frame. Empty path
 * means the top-level document. This is the mechanism behind the accounts
 * page's "accounts-frame" case — every candidate strategy for a target
 * resolves inside this frame, not just structural_semantic ones (see the
 * comment on TargetSchema.framePath).
 */
export async function resolveFrame(page: Page, framePath: string[]): Promise<Frame | null> {
  let frame: Frame = page.mainFrame();
  for (const name of framePath) {
    const child = frame.childFrames().find((f) => f.name() === name);
    if (!child) return null;
    await child.waitForLoadState('domcontentloaded').catch(() => {});
    frame = child;
  }
  return frame;
}

/**
 * Rung 3, real fallback path. Tried in this order:
 *   1. A genuine <label> association (getByLabel) — in case the markup
 *      ever gains a proper for/aria relationship.
 *   2. The legacy table-form heuristic this rung exists for: find a
 *      <td>/<th> whose exact trimmed text is the label, then the first
 *      form control in a LATER cell of the same <tr>. This is what
 *      Playwright's built-in label matching does NOT do — it only
 *      understands <label> semantics, not table-cell adjacency.
 */
function resolveAssociatedLabel(frame: Frame, label: string): Locator {
  const escaped = escapeRegex(label);
  const cell = frame.locator('td, th').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).first();
  const row = cell.locator('xpath=ancestor::tr[1]');
  return row.locator('input, select, textarea, button');
}

/**
 * Rung 5. Finds the <table> containing a row whose first cell's text
 * equals `rowHeader`, resolves `columnHeader`'s index from that table's
 * <thead><th> row, and returns the cell at that index in the matched row.
 * No test IDs required — the row/column header pair IS the identity.
 */
async function resolveStructuralSemantic(
  frame: Frame,
  rowHeader: string,
  columnHeader: string,
): Promise<Locator | null> {
  const tables = frame.locator('table');
  const tableCount = await tables.count();
  for (let t = 0; t < tableCount; t++) {
    const table = tables.nth(t);
    const headerCells = table.locator('thead th');
    const headerCount = await headerCells.count();
    if (headerCount === 0) continue;

    let colIndex = -1;
    for (let i = 0; i < headerCount; i++) {
      const text = (await headerCells.nth(i).innerText()).trim();
      if (text === columnHeader) {
        colIndex = i;
        break;
      }
    }
    if (colIndex === -1) continue;

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    for (let r = 0; r < rowCount; r++) {
      const firstCellText = (await rows.nth(r).locator('td').first().innerText()).trim();
      if (firstCellText === rowHeader) {
        return rows.nth(r).locator('td').nth(colIndex);
      }
    }
  }
  return null;
}

/**
 * Rung 6. Minimal implementation — not exercised by the Slice 3 sample
 * capability (which only needs rungs 2/3/5). Kept real rather than a stub
 * so the ladder's shape is complete, but not hardened until a capability
 * actually depends on it. Documented, not silently missing.
 */
function resolveTextAnchor(
  frame: Frame,
  anchorText: string,
  relationship: 'first-input-below' | 'same-row' | 'next-sibling',
): Locator {
  const anchor = frame.getByText(anchorText, { exact: false }).first();
  if (relationship === 'same-row') {
    return anchor.locator('xpath=ancestor::tr[1]').locator('input, select, textarea, button');
  }
  if (relationship === 'next-sibling') {
    return anchor.locator('xpath=following-sibling::*[1]');
  }
  // first-input-below: nearest following form control in document order.
  return anchor.locator('xpath=following::input[1] | following::select[1] | following::textarea[1]');
}

async function resolveStrategy(frame: Frame, strategy: Strategy): Promise<Locator | null> {
  switch (strategy.type) {
    case 'semantic_id':
      return frame.locator(`#${strategy.id}`);
    case 'role_and_name':
      return frame.getByRole(strategy.role as Parameters<Frame['getByRole']>[0], {
        name: strategy.name || undefined,
        exact: strategy.exact,
      });
    case 'associated_label':
      return resolveAssociatedLabel(frame, strategy.label);
    case 'structural_semantic':
      return resolveStructuralSemantic(frame, strategy.rowHeader, strategy.columnHeader);
    case 'text_anchor':
      return resolveTextAnchor(frame, strategy.anchorText, strategy.relationship);
    case 'visible_text':
      return frame.getByText(strategy.text, { exact: false });
  }
}

/**
 * Tries each declared candidate strategy IN ORDER until one resolves to
 * exactly one element. Deliberately does NOT fall through to the next
 * candidate on ambiguity (>1 match) — ambiguity is a drift signal (the
 * artifact was compiled against a unique match; more than one now means
 * the app changed), not something to paper over by trying a weaker
 * strategy. Falling through only happens on a clean zero-match (the
 * strategy legitimately didn't find anything).
 */
export async function resolveTarget(page: Page, target: Target): Promise<TargetResolution> {
  const frame = await resolveFrame(page, target.framePath);
  if (!frame) return { outcome: 'frame_not_found', framePath: target.framePath };

  for (let i = 0; i < target.candidates.length; i++) {
    const candidate = target.candidates[i]!;
    const locator = await resolveStrategy(frame, candidate.strategy);
    if (!locator) continue;

    const count = await locator.count();
    if (count === 0) continue;
    if (count > 1) {
      return { outcome: 'ambiguous', matchedStrategyType: candidate.strategy.type, count };
    }
    return { outcome: 'resolved', locator, matchedRung: i, matchedStrategyType: candidate.strategy.type };
  }

  return { outcome: 'not_resolved' };
}
