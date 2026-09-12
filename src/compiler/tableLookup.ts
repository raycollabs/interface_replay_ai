import type { Frame, Page } from 'playwright';

export interface ColumnLocation {
  framePath: string[];
  rowHeader: string;
  columnHeader: string;
}

/**
 * Mechanical (non-LLM) structural discovery: given a column header hint
 * (e.g. "Balance"), search every table in every frame for a <thead><th>
 * whose text matches, then require exactly one data row in that table
 * before returning its row-identifying first cell. This is exactly the
 * inverse of resolveStructuralSemantic in src/surface/resolveTarget.ts --
 * that function goes (rowHeader, columnHeader) -> cell; this goes a
 * known column -> (rowHeader, columnHeader), deriving the strategy the
 * compiled artifact will use.
 *
 * More than one data row is a compile-time ambiguity, refused rather
 * than guessed at -- same principle as target-resolution ambiguity
 * during replay (see resolveTarget.ts's own doc comment): a strategy
 * that isn't provably unique doesn't get emitted into the artifact.
 */
async function findInFrame(frame: Frame, columnHeaderHint: string): Promise<ColumnLocation | { error: string } | null> {
  const tables = frame.locator('table');
  const tableCount = await tables.count();
  for (let t = 0; t < tableCount; t++) {
    const table = tables.nth(t);
    const headerCells = table.locator('thead th');
    const headerCount = await headerCells.count();
    let colIndex = -1;
    let columnHeader = '';
    for (let i = 0; i < headerCount; i++) {
      const text = (await headerCells.nth(i).innerText()).trim();
      if (text.toLowerCase() === columnHeaderHint.toLowerCase()) {
        colIndex = i;
        columnHeader = text;
        break;
      }
    }
    if (colIndex === -1) continue;

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    if (rowCount === 0) continue;
    if (rowCount > 1) {
      return { error: `Column "${columnHeaderHint}" found, but its table has ${rowCount} data rows -- not unique enough to compile a strategy from without a row-identifying value.` };
    }
    const rowHeader = (await rows.nth(0).locator('td').first().innerText()).trim();
    return { framePath: [], rowHeader, columnHeader };
  }
  return null;
}

export async function findColumnLocation(page: Page, columnHeaderHint: string): Promise<ColumnLocation | { error: string }> {
  const topResult = await findInFrame(page.mainFrame(), columnHeaderHint);
  if (topResult) return topResult;

  for (const child of page.mainFrame().childFrames()) {
    const name = child.name();
    if (!name) continue;
    const result = await findInFrame(child, columnHeaderHint);
    if (result && !('error' in result)) return { ...result, framePath: [name] };
    if (result && 'error' in result) return result;
  }

  return { error: `No table column header matching "${columnHeaderHint}" found in any frame.` };
}
