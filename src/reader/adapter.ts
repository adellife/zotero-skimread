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

/**
 * Jump the reader to a passage of text (used by the EPUB highlight list, where
 * positioned overlays are not available). Best-effort via the reader's find.
 */
export function navigateToText(reader: any, text: string): void {
  const query = text.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!query) return;
  const findState = {
    active: true,
    query,
    highlightAll: true,
    caseSensitive: false,
    entireWord: false,
    result: null,
  };
  try {
    const iv = reader?._internalReader;
    if (typeof reader?.setFindState === "function") {
      reader.setFindState(findState);
    } else if (typeof iv?.setFindState === "function") {
      iv.setFindState(findState);
    }
    iv?.findNext?.();
  } catch {
    // Navigation is a convenience; never throw from it.
  }
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

// ---- EPUB overlays ---------------------------------------------------------
// The EPUB reader is a reflowable, lazily-rendered HTML document with no
// viewport/rect layer, so PDF-style absolute overlays don't apply. Instead we
// paint with the CSS Custom Highlight API (CSS.highlights + Highlight ranges):
// fully non-destructive — it colors text without inserting any DOM nodes, so it
// never touches the book, its annotations, or the library. Sentences are
// located by whitespace-tolerant text search and repainted as sections render.

const EPUB_STYLE_ID = "skimread-epub-style";

function epubSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "x"
  );
}

// Text-matching normalization. Rendered book text and the model's quoted
// sentence routinely differ in ways that break a naive match: ligatures (ﬁ/ﬂ),
// curly vs straight quotes, soft hyphens and the many dash variants, and any
// amount of whitespace/line-wrapping. Normalize all of that away, per char, so
// a match can still be mapped back to exact positions.
// (Approach adapted from Drakonis96/nodus's highlighter, MIT.)
function normChar(ch: string): string {
  let s = String(ch)
    .normalize("NFKC") // ﬁ → fi, ﬂ → fl, and other compatibility forms
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"');
  // Drop whitespace and every hyphen/dash variant (incl. soft hyphen U+00AD).
  s = s.replace(/[\s­‐-―−⁃-]/g, "");
  return s.toLowerCase();
}

function normalizeText(t: string): string {
  let out = "";
  for (const ch of String(t ?? "")) out += normChar(ch);
  return out;
}

// Locate a normalized quote in a normalized haystack. Tries an exact match
// first, then progressively shorter prefixes: long quotes drift near their end
// (a stray footnote marker, an odd glyph), and matching the opening 40-85% is
// far better than dropping the highlight entirely.
const PREFIX_RATIOS = [0.85, 0.7, 0.55, 0.4];

function findNormalizedIndex(
  haystack: string,
  q: string,
): { at: number; len: number } | null {
  if (!q || q.length < 8) return null;
  const at = haystack.indexOf(q);
  if (at >= 0) return { at, len: q.length };
  for (const ratio of PREFIX_RATIOS) {
    const len = Math.floor(q.length * ratio);
    if (len < 12 || len >= q.length) continue;
    const hit = haystack.indexOf(q.slice(0, len));
    if (hit >= 0) return { at: hit, len };
  }
  return null;
}

interface EpubHandle {
  pv: any;
  doc: any; // xray-waived iframe document
  win: any; // xray-waived iframe window
}

function getEpubHandle(reader: any): EpubHandle | null {
  const pv = reader?._internalReader?._primaryView;
  const rawDoc = pv?._iframeDocument;
  const rawWin = pv?._iframeWindow;
  if (!rawDoc || !rawWin) return null;
  const win = Cu.waiveXrays(rawWin);
  const doc = Cu.waiveXrays(rawDoc);
  if (typeof win.Highlight !== "function" || !win.CSS?.highlights) return null;
  return { pv, doc, win };
}

/** Whether EPUB overlays can be painted for this reader/runtime. */
export function canPaintEpub(reader: any): boolean {
  return !!getEpubHandle(reader);
}

const EPUB_FLAG_LAYER_ID = "skimread-flag-layer";

/**
 * Build a normalized text index over the currently rendered EPUB body, with a
 * per-character map back to (textNode, offset). Shared by the painter and by
 * annotation export so both locate a sentence exactly the same way.
 */
function buildEpubIndex(doc: any): { s: string; map: Array<[any, number]> } {
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  let s = "";
  const map: Array<[any, number]> = [];
  let node: any;
  while ((node = walker.nextNode())) {
    const p = node.parentElement;
    if (!p || !p.getClientRects || p.getClientRects().length === 0) continue;
    const t: string = node.textContent || "";
    for (let i = 0; i < t.length; i++) {
      const ns = normChar(t[i]);
      for (let k = 0; k < ns.length; k++) {
        s += ns[k];
        map.push([node, i]);
      }
    }
  }
  return { s, map };
}

/** Locate one normalized query in the index and return its DOM range. */
function epubRangeForQuery(
  doc: any,
  q: string,
  s: string,
  map: Array<[any, number]>,
): any | null {
  const hit = findNormalizedIndex(s, q);
  if (!hit) return null;
  const a = map[hit.at];
  const b = map[hit.at + hit.len - 1];
  if (!a || !b) return null;
  try {
    const range = doc.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1] + 1);
    return range;
  } catch {
    return null;
  }
}

/**
 * Convert highlight specs into Zotero annotation JSON for an EPUB.
 *
 * EPUB annotations are positioned by CFI rather than page rects, and the reader
 * view already knows how to produce one from a DOM range — the same ranges the
 * overlay painter builds. Only sentences in currently-rendered sections can be
 * converted, so unrendered chapters are reported back as skipped rather than
 * silently dropped.
 */
export function epubAnnotationsFromSpecs(
  reader: any,
  specs: HighlightSpec[],
): { annotations: any[]; skipped: number } {
  const h = getEpubHandle(reader);
  if (!h) return { annotations: [], skipped: specs.length };
  const { pv, doc } = h;
  if (typeof pv.getAnnotationFromRange !== "function") {
    return { annotations: [], skipped: specs.length };
  }
  const { s, map } = buildEpubIndex(doc);
  const annotations: any[] = [];
  let skipped = 0;
  for (const spec of specs) {
    const q = normalizeText(spec.text);
    const range = q ? epubRangeForQuery(doc, q, s, map) : null;
    if (!range) {
      skipped++;
      continue;
    }
    try {
      const ann = pv.getAnnotationFromRange(
        range,
        "highlight",
        hexColor(spec.colorRGB),
      );
      // Carry the rhetorical label alongside; the caller turns it into a tag.
      if (ann?.position)
        annotations.push({ ...ann, skimreadLabel: spec.label });
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { annotations, skipped };
}

function hexColor(colorRGB: string): string {
  const parts = colorRGB.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
    return "#ffd400";
  }
  return `#${parts
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export async function installEpubOverlays(
  reader: any,
  specs: HighlightSpec[],
  opacityPct: number,
  showFlags = true,
): Promise<OverlayController | null> {
  const h = getEpubHandle(reader);
  if (!h) return null;
  const { pv, doc, win } = h;

  // Group each label's sentence queries under its color; one Highlight per label.
  // Keep a flat list too, so flags can be placed per individual sentence.
  const byLabel = new Map<string, { color: string; queries: string[] }>();
  const flagSpecs: Array<{ query: string; color: string; label: string }> = [];
  for (const s of specs) {
    const key = epubSlug(s.label || "highlight");
    if (!byLabel.has(key)) byLabel.set(key, { color: s.colorRGB, queries: [] });
    const q = normalizeText(s.text);
    if (q) {
      byLabel.get(key)!.queries.push(q);
      flagSpecs.push({ query: q, color: s.colorRGB, label: s.label || "" });
    }
  }

  const styleFor = () =>
    Array.from(byLabel.entries())
      .map(
        ([k, v]) =>
          `::highlight(skimread-${k}){background-color:rgba(${v.color}, ${
            opacityPct / 100
          });border-radius:2px;}`,
      )
      .join("");

  let style = doc.getElementById(EPUB_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = EPUB_STYLE_ID;
    doc.head.appendChild(style);
  }
  style.textContent = styleFor();

  // Concatenate all currently-rendered text into a normalized string with a
  // per-character map back to (textNode, offset). Nodes inside <template>
  // (unrendered sections) have no client rects and are skipped. A single source
  // glyph can expand to several normalized chars (ligatures), so each expanded
  // position maps back to the same source offset — a matched range still covers
  // the whole glyph.
  const buildIndex = () => buildEpubIndex(doc);

  // Locate one query's first rendered occurrence and return its DOM range.
  const rangeForQuery = (
    q: string,
    s: string,
    map: Array<[any, number]>,
  ): any | null => {
    const hit = findNormalizedIndex(s, q);
    if (!hit) return null; // section not rendered yet, or text differs
    const a = map[hit.at];
    const b = map[hit.at + hit.len - 1];
    if (!a || !b) return null;
    try {
      const range = doc.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1] + 1);
      return range;
    } catch {
      return null; // node detached between index build and range creation
    }
  };

  // Flags are positioned overlay chips in a fixed layer, hugging the left edge
  // of each highlighted sentence — the EPUB analogue of the PDF margin flags.
  // The layer holds no book content; it is removed wholesale on clear().
  const ensureFlagLayer = (): any => {
    let layer = doc.getElementById(EPUB_FLAG_LAYER_ID);
    if (!layer) {
      layer = doc.createElement("div");
      layer.id = EPUB_FLAG_LAYER_ID;
      layer.setAttribute(
        "style",
        "position:fixed;inset:0;z-index:2147483646;pointer-events:none;",
      );
      doc.body.appendChild(layer);
    }
    return layer;
  };

  // Place a flag per visible highlighted sentence, de-duplicating chips that
  // would stack on the same line. Ranges track the text automatically, so this
  // just re-reads their current viewport rects (cheap on page turns).
  const positionFlags = (rangesWithLabel: any[]) => {
    if (!showFlags) return;
    const layer = ensureFlagLayer();
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const H = win.innerHeight;
    const W = win.innerWidth;
    const usedTops: number[] = [];
    for (const rl of rangesWithLabel) {
      const rc = rl.range.getClientRects()[0];
      if (!rc || rc.width === 0) continue;
      // Only the current column/viewport; paginated columns lay text out well
      // outside the visible strip.
      if (rc.top < 0 || rc.top > H - 6 || rc.left < 0 || rc.left > W) continue;
      if (usedTops.some((t) => Math.abs(t - rc.top) < 12)) continue;
      usedTops.push(rc.top);
      const name = rl.label
        ? rl.label.charAt(0).toUpperCase() + rl.label.slice(1)
        : "";
      const flag = doc.createElement("div");
      flag.textContent = name;
      // Anchor the chip's right edge just left of the text; fall back to the far
      // left margin when the text starts too close to the edge.
      const anchor =
        rc.left > 60
          ? `left:auto;right:${Math.round(W - rc.left + 4)}px;`
          : `left:2px;`;
      flag.setAttribute(
        "style",
        "position:fixed;" +
          anchor +
          `top:${Math.round(rc.top)}px;` +
          "font:600 9px sans-serif;padding:1px 5px 1px 4px;" +
          "background:#fff;color:#2e414f;border-radius:2px 0 0 2px;" +
          `border-right:3px solid rgb(${rl.color});` +
          "box-shadow:0 0 2px rgba(0,0,0,0.35);white-space:nowrap;",
      );
      layer.appendChild(flag);
    }
  };

  // Ranges kept between paints so page-turn reflows can reposition flags
  // without re-searching the text.
  let flagRanges: any[] = [];

  const repaintAll = async () => {
    const { s, map } = buildIndex();
    // Highlights: one CSS Highlight per label.
    for (const [k, v] of byLabel) {
      const ranges: any[] = [];
      for (const q of v.queries) {
        const range = rangeForQuery(q, s, map);
        if (range) ranges.push(range);
      }
      const name = `skimread-${k}`;
      if (ranges.length) {
        win.CSS.highlights.set(name, new win.Highlight(...ranges));
      } else {
        win.CSS.highlights.delete(name);
      }
    }
    // Flags: one chip per sentence.
    flagRanges = [];
    for (const fs of flagSpecs) {
      const range = rangeForQuery(fs.query, s, map);
      if (range) flagRanges.push({ range, color: fs.color, label: fs.label });
    }
    positionFlags(flagRanges);
  };

  await repaintAll();

  // Repaint as lazily-rendered sections mount / the book reflows (debounced).
  let timer = 0;
  const schedule = Cu.exportFunction(() => {
    if (timer) return;
    timer = win.setTimeout(() => {
      timer = 0;
      repaintAll().catch(() => {});
    }, 150);
  }, win);
  const observer = new win.MutationObserver(schedule);
  try {
    observer.observe(
      pv._sectionsContainer || doc.body,
      Cu.cloneInto({ childList: true, subtree: true }, win),
    );
  } catch {
    // observer is a convenience; painting still works for rendered sections
  }

  // Reposition flags on page/column turns. The EPUB view calls
  // onChangeViewStats as the paginated columns shift; wrap it (and restore the
  // original on clear) so chips follow their sentences.
  const opts = pv._options;
  const origStats = opts?.onChangeViewStats;
  let flagTimer = 0;
  if (showFlags && opts) {
    opts.onChangeViewStats = Cu.exportFunction(function (
      this: any,
      ...args: any[]
    ) {
      if (!flagTimer) {
        flagTimer = win.setTimeout(() => {
          flagTimer = 0;
          try {
            positionFlags(flagRanges);
          } catch {
            // ignore transient reflow errors
          }
        }, 30);
      }
      if (typeof origStats === "function") return origStats.apply(this, args);
    }, win);
  }

  return {
    repaintAll,
    clear: () => {
      try {
        observer.disconnect();
      } catch {
        // reader may already be gone
      }
      try {
        if (timer) win.clearTimeout(timer);
        if (flagTimer) win.clearTimeout(flagTimer);
      } catch {
        // ignore
      }
      try {
        if (opts && opts.onChangeViewStats !== origStats)
          opts.onChangeViewStats = origStats;
      } catch {
        // ignore
      }
      try {
        for (const k of byLabel.keys())
          win.CSS.highlights.delete(`skimread-${k}`);
        doc.getElementById(EPUB_STYLE_ID)?.remove();
        doc.getElementById(EPUB_FLAG_LAYER_ID)?.remove();
      } catch {
        // iframe may already be gone
      }
    },
  };
}
