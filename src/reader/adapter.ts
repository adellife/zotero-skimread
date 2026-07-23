/**
 * The ONLY module that touches Zotero reader / pdf.js internals
 * (verified live against Zotero 9.0.6, pdf.js 5.4.0, Zotero pdf-reader fork).
 *
 * Highlights are ephemeral DOM overlay divs (class .skimread-hl) appended
 * to pdf.js page containers. They are NEVER Zotero annotations and never
 * touch the library or the PDF file. clearOverlays() removes every trace.
 */

declare const Components: any;

export interface PageChar {
  c: string;
  rect: [number, number, number, number]; // PDF coords [x1,y1,x2,y2]
  baseline: number;
  fontSize: number;
}

export interface PageText {
  pageIndex: number;
  text: string; // assembled text, includes synthesized spaces
  // charMap[i] = index into chars[] for text position i, or -1 for synthesized whitespace
  charMap: number[];
  chars: PageChar[];
}

export interface HighlightSpec {
  pageIndex: number;
  startChar: number; // index into PageText.chars
  endChar: number; // exclusive
  colorRGB: string; // "r, g, b"
  label: string; // category name shown on the margin flag
  /** The exact text saved if the user explicitly converts this overlay. */
  text: string;
}

interface ReaderHandle {
  reader: any;
  win: any; // xray-waived iframe window
  app: any; // PDFViewerApplication
}

const HL_CLASS = "skimread-hl";
const Cu = Components.utils;

/** Resolve the reader shown in the given main-window tab. */
export function getReaderForTab(tabID: string): any | null {
  return Zotero.Reader.getByTabID(tabID) || null;
}

export function isReaderAlive(reader: any): boolean {
  return !!reader && (Zotero.Reader._readers as any[]).includes(reader);
}

function getHandle(reader: any): ReaderHandle | null {
  const iframeWin = reader?._internalReader?._primaryView?._iframeWindow;
  if (!iframeWin) return null;
  const win = Cu.waiveXrays(iframeWin);
  const app = win.PDFViewerApplication;
  if (!app?.pdfDocument) return null;
  return { reader, win, app };
}

export function getPageCount(reader: any): number {
  return getHandle(reader)?.app?.pagesCount ?? 0;
}

/**
 * Extract text + per-char geometry for one page via the Zotero pdf.js fork's
 * getPageData. Synthesizes spaces/newlines from geometry so sentences can be
 * segmented from the assembled string.
 */
export async function extractPage(
  reader: any,
  pageIndex: number,
): Promise<PageText | null> {
  const h = getHandle(reader);
  if (!h) return null;
  const arg = Cu.cloneInto({ pageIndex }, h.win);
  const pd = await h.app.pdfDocument.getPageData(arg);
  const rawChars = pd?.chars;
  if (!rawChars || !rawChars.length) {
    return { pageIndex, text: "", charMap: [], chars: [] };
  }

  // Page furniture (running headers, footers, page numbers, footnotes) sits in
  // the top/bottom margins and, for footnotes, in a smaller font near the
  // bottom. Dropping it here keeps it out of every sentence and highlight box.
  const vb = pd.viewBox;
  const pageHeight =
    Array.isArray(vb) && vb.length >= 4 ? Number(vb[3]) - Number(vb[1]) : 0;
  const yMid = (rc: { rect: number[] }) => (rc.rect[1] + rc.rect[3]) / 2;

  // Body-text font size (median of non-rotated chars) to spot small footnotes.
  const sizes: number[] = [];
  for (const rc of rawChars) {
    if (!rc.rotation && !rc.diagonal) sizes.push(rc.fontSize ?? 10);
  }
  sizes.sort((a, b) => a - b);
  const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;

  const chars: PageChar[] = [];
  for (let i = 0; i < rawChars.length; i++) {
    const rc = rawChars[i];
    // Skip rotated/diagonal text (arXiv watermarks, stamps, vertical journal
    // banners). Mixing it into reading order corrupts both sentences and the
    // merged highlight rectangles.
    if (rc.rotation || rc.diagonal) continue;
    if (pageHeight > 0) {
      const y = yMid(rc);
      // Top/bottom 5.5% margins → headers, footers, page numbers.
      if (y > pageHeight * 0.945 || y < pageHeight * 0.055) continue;
      // Small font in the bottom 18% → footnotes.
      if (y < pageHeight * 0.18 && (rc.fontSize ?? 10) < medianSize * 0.82) {
        continue;
      }
    }
    chars.push({
      c: String(rc.u ?? rc.c ?? ""),
      rect: [rc.rect[0], rc.rect[1], rc.rect[2], rc.rect[3]],
      baseline: rc.baseline ?? rc.rect[1],
      fontSize: rc.fontSize ?? 10,
    });
  }
  if (!chars.length) {
    return { pageIndex, text: "", charMap: [], chars: [] };
  }
  let text = "";
  const charMap: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (i > 0) {
      const prev = chars[i - 1];
      const cur = chars[i];
      const newLine =
        Math.abs(cur.baseline - prev.baseline) > prev.fontSize * 0.5;
      const gap = cur.rect[0] - prev.rect[2];
      const space = !newLine && gap > prev.fontSize * 0.18;
      if (newLine || space) {
        text += " ";
        charMap.push(-1);
      }
    }
    for (const ch of chars[i].c) {
      text += ch;
      charMap.push(i);
    }
  }
  return { pageIndex, text, charMap, chars };
}

/** Merge per-char rects of a range into per-line rectangles. */
function rangeToLineRects(
  page: { chars: PageChar[] },
  startChar: number,
  endChar: number,
): [number, number, number, number][] {
  const rects: [number, number, number, number][] = [];
  let cur: [number, number, number, number] | null = null;
  let curBaseline = NaN;
  for (let i = startChar; i < endChar && i < page.chars.length; i++) {
    const ch = page.chars[i];
    const [x1, y1, x2, y2] = ch.rect;
    if (cur && Math.abs(ch.baseline - curBaseline) <= ch.fontSize * 0.5) {
      cur[0] = Math.min(cur[0], x1);
      cur[1] = Math.min(cur[1], y1);
      cur[2] = Math.max(cur[2], x2);
      cur[3] = Math.max(cur[3], y2);
    } else {
      if (cur) rects.push(cur);
      cur = [x1, y1, x2, y2];
      curBaseline = ch.baseline;
    }
  }
  if (cur) rects.push(cur);
  // Geometry sanity net: a merged "line" can never be taller than a couple of
  // text lines. Anything bigger means stray geometry (rotated stamps, layout
  // artifacts) slipped in — dropping it is always better than a page-sized box.
  const maxHeight =
    Math.max(...page.chars.slice(startChar, endChar).map((c) => c.fontSize)) *
      2.5 || 40;
  return rects.filter((rect) => rect[3] - rect[1] <= maxHeight);
}

/** Convert a range to Zotero's native PDF annotation position format. */
export function annotationPositionForRange(
  page: PageText,
  startChar: number,
  endChar: number,
): { pageIndex: number; rects: number[][] } | null {
  const rects = rangeToLineRects(page, startChar, endChar);
  return rects.length ? { pageIndex: page.pageIndex, rects } : null;
}

/**
 * Paint highlight overlays for currently rendered pages and keep them alive
 * across zoom/re-render. Returns an unsubscribe/cleanup token.
 */
export interface OverlayController {
  repaintAll: () => Promise<void>;
  clear: () => void;
}

export async function installOverlays(
  reader: any,
  specs: HighlightSpec[],
  opacityPct: number,
  pageCache: Map<number, PageText>,
  showFlags = true,
): Promise<OverlayController | null> {
  const h = getHandle(reader);
  if (!h) return null;
  const byPage = new Map<number, HighlightSpec[]>();
  for (const s of specs) {
    if (!byPage.has(s.pageIndex)) byPage.set(s.pageIndex, []);
    byPage.get(s.pageIndex)!.push(s);
  }

  const doc = h.win.document;
  if (!doc.getElementById("skimread-style")) {
    const style = doc.createElement("style");
    style.id = "skimread-style";
    style.textContent =
      `.${HL_CLASS}{position:absolute;pointer-events:none;border-radius:2px;mix-blend-mode:multiply;z-index:3;}` +
      `.${HL_CLASS}-flag{position:absolute;pointer-events:none;z-index:4;font:600 9px sans-serif;` +
      `padding:1px 5px 1px 4px;border-radius:2px 0 0 2px;color:#2e414f;background:#fff;` +
      `box-shadow:0 0 2px rgba(0,0,0,0.35);white-space:nowrap;}`;
    doc.head.appendChild(style);
  }

  async function paintPage(pageIndex: number) {
    const pageSpecs = byPage.get(pageIndex);
    if (!pageSpecs) return;
    const pv = h!.app.pdfViewer._pages[pageIndex];
    const pageDiv = pv?.div;
    if (!pageDiv || !pv.viewport) return;
    // remove existing overlays for this page first (idempotent repaint)
    for (const el of Array.from(
      pageDiv.querySelectorAll(`.${HL_CLASS}`),
    ) as any[]) {
      el.remove();
    }
    if (!pv.canvas && pv.renderingState === 0) return; // not rendered yet
    let page = pageCache.get(pageIndex);
    if (!page) {
      page = (await extractPage(reader, pageIndex)) || (undefined as any);
      if (page) pageCache.set(pageIndex, page);
    }
    if (!page) return;
    for (const spec of pageSpecs) {
      const lineRects = rangeToLineRects(page, spec.startChar, spec.endChar);
      let first = true;
      for (const r of lineRects) {
        const vr = pv.viewport.convertToViewportRectangle(
          Cu.cloneInto([r[0], r[1], r[2], r[3]], h!.win),
        );
        const left = Math.min(vr[0], vr[2]);
        const top = Math.min(vr[1], vr[3]);
        const width = Math.abs(vr[2] - vr[0]);
        const height = Math.abs(vr[3] - vr[1]);
        const div = doc.createElement("div");
        div.className = HL_CLASS;
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
        div.style.backgroundColor = `rgba(${spec.colorRGB}, ${opacityPct / 100})`;
        pageDiv.appendChild(div);
        if (first && showFlags && spec.label) {
          const flag = doc.createElement("div");
          flag.className = `${HL_CLASS} ${HL_CLASS}-flag`;
          flag.textContent =
            spec.label.charAt(0).toUpperCase() + spec.label.slice(1);
          flag.style.top = `${top}px`;
          flag.style.left = "2px";
          flag.style.borderRight = `3px solid rgb(${spec.colorRGB})`;
          pageDiv.appendChild(flag);
        }
        first = false;
      }
    }
  }

  async function repaintAll() {
    for (const pageIndex of byPage.keys()) {
      try {
        await paintPage(pageIndex);
      } catch (e) {
        ztoolkit.log("skimread paint error", pageIndex, e);
      }
    }
  }

  // Repaint lazily-rendered / re-rendered pages.
  const listener = Cu.exportFunction((evt: any) => {
    const idx = (evt?.pageNumber ?? 0) - 1;
    if (byPage.has(idx)) {
      paintPage(idx).catch(() => {});
    }
  }, h.win);
  h.app.eventBus.on("pagerendered", listener);

  await repaintAll();

  return {
    repaintAll,
    clear: () => {
      try {
        h.app.eventBus.off("pagerendered", listener);
      } catch {
        // reader may already be gone
      }
      try {
        for (const el of Array.from(
          h.win.document.querySelectorAll(`.${HL_CLASS}`),
        ) as any[]) {
          el.remove();
        }
      } catch {
        // iframe may already be gone
      }
    },
  };
}
