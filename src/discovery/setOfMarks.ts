import type { Frame, Page } from 'playwright';

export interface ObservedControl {
  mark: number;
  role: string;
  accessibleName: string;
  tag: string;
  framePath: string[];
  /** True for controls in the top-level document, which get a numbered
   *  visual badge in the screenshot. Iframe-nested controls (our target
   *  app's account fields) still get a mark and appear in the text
   *  inventory, but without a badge -- overlaying badges correctly
   *  across frame boundaries needs coordinate translation that isn't
   *  worth the complexity for this project's one iframe case. The model
   *  can still act on them by mark number from the text description
   *  alone; documented here rather than silently missing. */
  badged: boolean;
}

interface MarkedElement {
  mark: number;
  role: string;
  accessibleName: string;
  tag: string;
  box: { x: number; y: number; width: number; height: number } | null;
}

/**
 * The in-browser scan, as a raw source string rather than a real
 * TypeScript function passed to page.evaluate(). This is deliberate:
 * tsx/esbuild's keepNames transform wraps named nested functions with
 * calls to a `__name()` helper that only exists elsewhere in the bundle
 * -- Playwright serializes just this one function's source via
 * toString() to run in the isolated page context, where that helper is
 * undefined, producing "ReferenceError: __name is not defined" at
 * runtime. A plain string is never run through esbuild's AST transform,
 * so it never picks up that wrapping. The accessible-name heuristic
 * mirrors (doesn't share code with, for the same reason) resolveTarget.ts's
 * associated_label rung: aria-label, then a real <label for>, then the
 * legacy table-cell-adjacency pattern this target app actually uses.
 */
function markFrameScript(startMark: number): string {
  return `(function () {
    function computeAccessibleName(el) {
      var ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      if (el.id) {
        var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label && label.textContent) return label.textContent.trim();
      }
      // Buttons/links carry their own visible text as their name -- check
      // this BEFORE the table-row heuristic below. Getting this order
      // backwards was a real bug: a submit button sitting in a row whose
      // PRECEDING cell is empty (a common table-form layout, ours
      // included) would return "" from the row heuristic and never fall
      // through to its own text. The row-adjacency heuristic exists for
      // inputs that have no visible text of their own -- it should never
      // shadow a button/link's real name.
      var tagEarly = el.tagName.toLowerCase();
      if (tagEarly === 'button' || tagEarly === 'a') {
        var ownText = (el.textContent || '').trim();
        if (ownText) return ownText;
      }
      var row = el.closest('tr');
      if (row) {
        var cells = Array.from(row.querySelectorAll('td,th'));
        var idx = cells.findIndex(function (c) { return c.contains(el); });
        if (idx > 0) return (cells[idx - 1].textContent || '').trim();
      }
      var tag = el.tagName.toLowerCase();
      if (el.placeholder) return el.placeholder;
      if (tag === 'input' && (el.type === 'submit' || el.type === 'button')) return el.value || '';
      return '';
    }
    function computeRole(el) {
      var explicit = el.getAttribute('role');
      if (explicit) return explicit;
      var tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        var t = (el.type || 'text').toLowerCase();
        if (t === 'submit' || t === 'button') return 'button';
        return 'textbox';
      }
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      return tag;
    }
    var elements = Array.from(document.querySelectorAll('input, button, a[href], select, textarea, [role]'));
    var mark = ${JSON.stringify(startMark)};
    var results = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      el.dataset.discoveryMark = String(mark);
      results.push({
        mark: mark,
        role: computeRole(el),
        accessibleName: computeAccessibleName(el),
        tag: el.tagName.toLowerCase(),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      mark++;
    }
    return results;
  })()`;
}

async function markFrame(frame: Frame, startMark: number): Promise<MarkedElement[]> {
  return frame.evaluate(markFrameScript(startMark));
}

async function drawBadges(
  frame: Frame,
  marks: Array<{ mark: number; box: { x: number; y: number; width: number; height: number } | null }>,
): Promise<void> {
  await frame.evaluate((marks) => {
    const container = document.createElement('div');
    container.id = '__discovery_badges__';
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.zIndex = '2147483647';
    container.style.pointerEvents = 'none';
    for (const m of marks) {
      if (!m.box) continue;
      const badge = document.createElement('div');
      badge.textContent = String(m.mark);
      badge.style.position = 'absolute';
      badge.style.left = `${m.box.x}px`;
      badge.style.top = `${Math.max(0, m.box.y - 14)}px`;
      badge.style.background = '#ff3b30';
      badge.style.color = '#fff';
      badge.style.font = 'bold 11px sans-serif';
      badge.style.padding = '1px 4px';
      badge.style.borderRadius = '3px';
      badge.style.lineHeight = '1.2';
      container.appendChild(badge);
    }
    document.body.appendChild(container);
  }, marks);
}

async function removeBadges(frame: Frame): Promise<void> {
  await frame
    .evaluate(() => {
      document.getElementById('__discovery_badges__')?.remove();
    })
    .catch(() => {});
}

/**
 * The set-of-marks observation: marks every interactive control (top
 * frame and named child frames) with a stable, mark-numbered attribute,
 * overlays visual badges for the top-level frame only, screenshots, then
 * removes the badges (the data-discovery-mark attributes stay -- that's
 * what the next action resolves against). This is a discovery-only
 * concern; deterministic replay never needs it (see Slice 2's scope
 * note).
 */
export async function observeWithMarks(
  page: Page,
  screenshotPath: string,
): Promise<{ controls: ObservedControl[] }> {
  const controls: ObservedControl[] = [];
  let nextMark = 1;

  const topMarks = await markFrame(page.mainFrame(), nextMark);
  for (const m of topMarks) {
    controls.push({ mark: m.mark, role: m.role, accessibleName: m.accessibleName, tag: m.tag, framePath: [], badged: true });
  }
  nextMark += topMarks.length;
  await drawBadges(page.mainFrame(), topMarks);

  for (const child of page.mainFrame().childFrames()) {
    const name = child.name();
    if (!name) continue;
    await child.waitForLoadState('domcontentloaded').catch(() => {});
    const childMarks = await markFrame(child, nextMark).catch(() => []);
    for (const m of childMarks) {
      controls.push({ mark: m.mark, role: m.role, accessibleName: m.accessibleName, tag: m.tag, framePath: [name], badged: false });
    }
    nextMark += childMarks.length;
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await removeBadges(page.mainFrame());

  return { controls };
}

/** Resolves a mark number (assigned by the most recent observeWithMarks
 *  call) back to a live locator, using the ObservedControl's own
 *  recorded framePath -- mirrors resolveFrame in src/surface/resolveTarget.ts. */
export async function resolveMark(page: Page, control: ObservedControl) {
  let frame: Frame = page.mainFrame();
  for (const name of control.framePath) {
    const child = frame.childFrames().find((f) => f.name() === name);
    if (!child) return null;
    frame = child;
  }
  return frame.locator(`[data-discovery-mark="${control.mark}"]`);
}
