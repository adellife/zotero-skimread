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

/** Base margin-flag metrics at 100% zoom, in CSS pixels. */
const FLAG_BASE_FONT = 9;
const FLAG_BASE_BORDER = 3;

/**
 * Size a margin flag for the current zoom. Flags sit alongside text that scales
 * with the viewport, so a fixed pixel size reads as "too small" zoomed in and
 * oversized zoomed out. Clamped: below ~0.85 the text becomes unreadable, above
 * ~2 the chip starts crowding the margin.
 */
function applyFlagScale(flag: any, rawScale: number, colorRGB: string): void {
  const scale = Math.max(0.85, Math.min(2, rawScale || 1));
  const px = (n: number) => `${(n * scale).toFixed(1)}px`;
  flag.style.font = `600 ${px(FLAG_BASE_FONT)} sans-serif`;
  flag.style.padding = `${px(1)} ${px(5)} ${px(1)} ${px(4)}`;
  flag.style.borderRight = `${px(FLAG_BASE_BORDER)} solid rgb(${colorRGB})`;
  flag.style.borderRadius = `${px(2)} 0 0 ${px(2)}`;
}

/**
 * Keep a flag wholly inside the whitespace before a text column. Long custom
 * labels are clipped rather than allowed to cover the paper.
 */
export function marginFlagLayout(
  textLeft: number,
  naturalWidth: number,
): { left: number; maxWidth: number } {
  const pageInset = 2;
  const textGap = 4;
  const boundary = Math.max(pageInset + textGap + 1, textLeft);
  const maxWidth = Math.max(1, boundary - textGap - pageInset);
  const width = Math.min(Math.max(1, naturalWidth), maxWidth);
  return {
    left: Math.max(pageInset, boundary - textGap - width),
    maxWidth,
  };
}

/**
 * Margin flags are intentionally narrow badges. The full label remains in the
 * sidebar and accessibility text; the badge never expands over PDF prose.
 */
export function abbreviateFlagLabel(label: string): string {
  const words = String(label || "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (!words.length) return "";
  if (words.length > 1) {
    return words
      .slice(0, 3)
      .map((word) => word.charAt(0))
      .join("")
      .toUpperCase();
  }
  return words[0].slice(0, 2).toUpperCase();
}

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

export interface PageStructureHints {
  title?: string;
  creators?: string[];
}

interface VisualLine {
  chars: PageChar[];
  text: string;
  baseline: number;
  fontSize: number;
  x1: number;
  x2: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function lineText(chars: PageChar[]): string {
  let text = "";
  for (let i = 0; i < chars.length; i++) {
    if (i) {
      const prev = chars[i - 1];
      const cur = chars[i];
      const gap = Math.max(
        cur.rect[0] - prev.rect[2],
        prev.rect[0] - cur.rect[2],
      );
      if (gap > prev.fontSize * 0.18) text += " ";
    }
    text += chars[i].c;
  }
  return text.replace(/\s+/g, " ").trim();
}

function describeVisualLine(chars: PageChar[]): VisualLine {
  const ordered = [...chars].sort(
    (a, b) => a.rect[0] - b.rect[0] || b.rect[2] - a.rect[2],
  );
  return {
    chars: ordered,
    text: lineText(ordered),
    baseline: median(ordered.map((char) => char.baseline)),
    fontSize: median(ordered.map((char) => char.fontSize)),
    x1: Math.min(...ordered.map((char) => char.rect[0])),
    x2: Math.max(...ordered.map((char) => char.rect[2])),
  };
}

/**
 * Cluster characters by geometry instead of trusting PDF object order. Some
 * publishers interleave left- and right-column objects row by row; treating
 * that stream as prose fuses keywords or affiliations into the abstract.
 */
function visualLines(chars: PageChar[], pageWidth: number): VisualLine[] {
  const clusters: Array<{
    chars: PageChar[];
    baseline: number;
    fontSize: number;
  }> = [];
  const sorted = [...chars].sort(
    (a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0],
  );
  for (const char of sorted) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < clusters.length; index++) {
      const line = clusters[index];
      const distance = Math.abs(char.baseline - line.baseline);
      const tolerance = Math.max(
        1,
        Math.min(char.fontSize || 10, line.fontSize || 10) * 0.48,
      );
      if (distance <= tolerance && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    if (best >= 0) {
      const cluster = clusters[best];
      const count = cluster.chars.length;
      cluster.chars.push(char);
      cluster.baseline =
        (cluster.baseline * count + char.baseline) / (count + 1);
      cluster.fontSize =
        (cluster.fontSize * count + char.fontSize) / (count + 1);
    } else {
      clusters.push({
        chars: [char],
        baseline: char.baseline,
        fontSize: char.fontSize,
      });
    }
  }

  const lines = clusters.map((cluster) => describeVisualLine(cluster.chars));
  if (pageWidth <= 0) return lines;

  // Detect a repeated gutter. First-page abstract layouts are often asymmetric
  // (a narrow keyword rail beside a wide abstract), so the gutter must be
  // inferred from repeated aligned gaps rather than assumed to sit at 50%.
  const threshold = Math.max(12, pageWidth * 0.018);
  const candidates: Array<{
    line: VisualLine;
    index: number;
    center: number;
    width: number;
  }> = [];
  for (const line of lines) {
    const gaps = line.chars
      .slice(1)
      .map((char, index) => ({
        index: index + 1,
        width: char.rect[0] - line.chars[index].rect[2],
        center: (char.rect[0] + line.chars[index].rect[2]) / 2,
      }))
      .filter(
        (gap) =>
          gap.width >= threshold &&
          gap.center >= pageWidth * 0.12 &&
          gap.center <= pageWidth * 0.88 &&
          gap.index >= 4 &&
          line.chars.length - gap.index >= 4,
      )
      .sort((a, b) => b.width - a.width);
    for (const gap of gaps) candidates.push({ line, ...gap });
  }
  if (candidates.length < 2) return lines;

  const centerTolerance = Math.max(12, pageWidth * 0.045);
  const groups: (typeof candidates)[] = [];
  for (const candidate of [...candidates].sort((a, b) => a.center - b.center)) {
    const group = groups.find((entries) => {
      const center =
        entries.reduce((sum, entry) => sum + entry.center, 0) / entries.length;
      return Math.abs(candidate.center - center) <= centerTolerance;
    });
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const repeated = groups
    .filter(
      (group) => new Set(group.map((candidate) => candidate.line)).size >= 2,
    )
    .sort(
      (a, b) =>
        new Set(b.map((candidate) => candidate.line)).size -
          new Set(a.map((candidate) => candidate.line)).size ||
        b.reduce((sum, candidate) => sum + candidate.width, 0) -
          a.reduce((sum, candidate) => sum + candidate.width, 0),
    )[0];
  if (!repeated) return lines;
  const gutter = median(repeated.map((candidate) => candidate.center));
  const splitLines: VisualLine[] = [];
  for (const line of lines) {
    const split = line.chars
      .slice(1)
      .map((char, index) => ({
        index: index + 1,
        width: char.rect[0] - line.chars[index].rect[2],
        left: line.chars[index].rect[2],
        right: char.rect[0],
      }))
      .filter(
        (gap) =>
          gap.width >= threshold &&
          gap.left <= gutter &&
          gap.right >= gutter &&
          gap.index >= 4 &&
          line.chars.length - gap.index >= 4,
      )
      .sort((a, b) => b.width - a.width)[0];
    if (!split) {
      splitLines.push(line);
      continue;
    }
    splitLines.push(
      describeVisualLine(line.chars.slice(0, split.index)),
      describeVisualLine(line.chars.slice(split.index)),
    );
  }
  return splitLines;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bodyFontSize(chars: PageChar[]): number {
  const counts = new Map<number, number>();
  for (const char of chars) {
    if (char.fontSize < 4) continue;
    const size = Math.round(char.fontSize * 2) / 2;
    counts.set(size, (counts.get(size) || 0) + Math.max(1, char.c.length));
  }
  let bestSize = 10;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      bestSize = size;
      bestCount = count;
    }
  }
  return bestSize;
}

function looksLikeHeading(text: string): boolean {
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  if (!words.length || words.length > 16 || /[.!?]\s*$/.test(text)) {
    return false;
  }
  const numbered = /^\s*(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)-]?\s+/i.test(text);
  const capitals = words.filter(
    (word) => /^[A-Z]/.test(word) || word === word.toUpperCase(),
  ).length;
  return numbered || capitals / words.length >= 0.6;
}

function structureHintsForReader(reader: any): PageStructureHints {
  try {
    const attachment = Zotero.Items.get(reader.itemID);
    const parent = attachment?.parentItem ?? attachment;
    return {
      title: String(parent?.getField("title") || ""),
      creators: (parent?.getCreators?.() || []).map(
        (creator: { firstName?: string; lastName?: string }) =>
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      ),
    };
  } catch {
    return {};
  }
}

function readingOrder(lines: VisualLine[], pageWidth: number): VisualLine[] {
  if (!lines.length || pageWidth <= 0) return lines;
  const midpoint = pageWidth / 2;
  const narrow = lines.filter((line) => line.x2 - line.x1 < pageWidth * 0.58);
  const left = narrow.filter((line) => (line.x1 + line.x2) / 2 < midpoint);
  const right = narrow.filter((line) => (line.x1 + line.x2) / 2 >= midpoint);
  const topDown = (a: VisualLine, b: VisualLine) =>
    b.baseline - a.baseline || a.x1 - b.x1;
  if (left.length < 3 || right.length < 3) {
    return [...lines].sort(topDown);
  }
  const columnTop = Math.max(...narrow.map((line) => line.baseline));
  const columnBottom = Math.min(...narrow.map((line) => line.baseline));
  const spanning = lines.filter((line) => !narrow.includes(line));
  const above = spanning.filter((line) => line.baseline > columnTop);
  const below = spanning.filter((line) => line.baseline < columnBottom);
  const within = spanning.filter(
    (line) => line.baseline <= columnTop && line.baseline >= columnBottom,
  );
  // Spanning prose above two columns is commonly an abstract. A spanning line
  // inside the column range is kept after the columns; headings have already
  // been removed, so this is a conservative ordering for unusual layouts.
  return [
    ...above.sort(topDown),
    ...left.sort(topDown),
    ...right.sort(topDown),
    ...within.sort(topDown),
    ...below.sort(topDown),
  ];
}

/**
 * Convert filtered pdf.js characters into structural prose. This is exported
 * for fixture tests: title/author/metadata decisions must be verified before
 * an LLM ever sees a sentence.
 */
export function buildStructuredPage(
  pageIndex: number,
  chars: PageChar[],
  pageWidth: number,
  hints: PageStructureHints = {},
): PageText {
  const lines = visualLines(chars, pageWidth);
  const bodySize = bodyFontSize(chars);
  const title = normalized(hints.title || "");
  const creators = (hints.creators || [])
    .map(normalized)
    .filter((creator) => creator.length >= 4);
  let keywordColumn: "left" | "right" | null = null;
  const eligible: VisualLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    const key = normalized(text);
    if (!text || !key) continue;
    const lineColumn =
      (line.x1 + line.x2) / 2 < pageWidth / 2 ? "left" : "right";
    const exactHeading = /^(?:abstract|keywords?|keyterms?|articleinfo)$/i.test(
      key,
    );
    if (/^(?:keywords?|keyterms?)$/i.test(key)) {
      keywordColumn = lineColumn;
      continue;
    }
    if (
      pageIndex === 0 &&
      keywordColumn === lineColumn &&
      line.x2 - line.x1 < pageWidth * 0.38 &&
      !/[.!?]\s*$/.test(text)
    ) {
      continue;
    }
    const titleMatch =
      pageIndex === 0 &&
      key.length >= 6 &&
      title.length >= 6 &&
      (title.includes(key) || key.includes(title));
    const creatorMatch =
      pageIndex === 0 &&
      creators.some(
        (creator) => key.includes(creator) || creator.includes(key),
      );
    const lower = text.toLowerCase();
    const metadataLine =
      !/[.!?]\s*$/.test(text) &&
      text.split(/\s+/).length <= 35 &&
      /contents\s+lists?\s+available|science\s*direct|journal\s+homepage|facult|universit|department|institute|pavillon|rue\b|street\b|road\b|avenue\b|postal\b|québec|quebec|canada\b|article\s+info/i.test(
        lower,
      );
    const metadata =
      pageIndex === 0 &&
      (/doi\s*:|doi\.org|creative\s*commons|copyright|article\s+reuse|journal|corresponding\s+author|e-?mail\s*:|university|issn|sagepub|open\s+access|special\s+issue|online\s+supplementary\s+material|version\s+in\s+\w+\s+of\s+this\s+article|©/i.test(
        lower,
      ) ||
        metadataLine ||
        line.fontSize <= bodySize * 0.82);
    const hidden = line.fontSize <= Math.max(3, bodySize * 0.35);
    const largeHeading = line.fontSize >= bodySize * 1.28;
    const textHeading = looksLikeHeading(text);
    if (
      exactHeading ||
      titleMatch ||
      creatorMatch ||
      metadata ||
      hidden ||
      largeHeading ||
      textHeading
    ) {
      continue;
    }
    eligible.push(line);
  }

  const orderedLines = readingOrder(eligible, pageWidth);
  const orderedChars = orderedLines.flatMap((line) => line.chars);
  let text = "";
  const charMap: number[] = [];
  for (let i = 0; i < orderedChars.length; i++) {
    if (i > 0) {
      const prev = orderedChars[i - 1];
      const cur = orderedChars[i];
      const newLine =
        Math.abs(cur.baseline - prev.baseline) > prev.fontSize * 0.5;
      const gap = Math.max(
        cur.rect[0] - prev.rect[2],
        prev.rect[0] - cur.rect[2],
      );
      const space = !newLine && gap > prev.fontSize * 0.18;
      if (newLine || space) {
        text += " ";
        charMap.push(-1);
      }
    }
    for (const character of orderedChars[i].c) {
      text += character;
      charMap.push(i);
    }
  }
  return { pageIndex, text, charMap, chars: orderedChars };
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
  const pageWidth =
    Array.isArray(vb) && vb.length >= 4 ? Number(vb[2]) - Number(vb[0]) : 0;
  return buildStructuredPage(
    pageIndex,
    chars,
    pageWidth,
    structureHintsForReader(reader),
  );
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
      `box-shadow:0 0 2px rgba(0,0,0,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}`;
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

    // Find the actual left edge of readable page text. Filtering relative to
    // the median font size excludes tiny hidden publisher/metadata text that
    // otherwise makes the apparent margin collapse.
    const visibleChars = page.chars.filter((char) => char.c.trim());
    const fontSizes = visibleChars
      .map((char) => char.fontSize)
      .filter((size) => size > 0)
      .sort((a, b) => a - b);
    const medianFont = fontSizes[Math.floor(fontSizes.length / 2)] || 1;
    const textLefts = visibleChars
      .filter((char) => char.fontSize >= medianFont * 0.6)
      .map((char) => {
        const vr = pv.viewport.convertToViewportRectangle(
          Cu.cloneInto([...char.rect], h!.win),
        );
        return Math.min(vr[0], vr[2]);
      });
    const detectedTextLeft = textLefts.reduce(
      (left, candidate) => Math.min(left, candidate),
      Number.POSITIVE_INFINITY,
    );
    const pageTextLeft = Number.isFinite(detectedTextLeft)
      ? detectedTextLeft
      : 48;

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
          flag.textContent = abbreviateFlagLabel(spec.label);
          flag.title = spec.label.charAt(0).toUpperCase() + spec.label.slice(1);
          flag.setAttribute("aria-label", flag.title);
          flag.style.top = `${top}px`;
          // Highlight rects are in viewport coordinates and grow with zoom, so
          // a fixed-size chip shrinks relative to the text. Scale it to match,
          // clamped so it stays legible when zoomed out and does not dominate
          // the margin when zoomed far in.
          applyFlagScale(flag, pv.viewport?.scale ?? 1, spec.colorRGB);
          pageDiv.appendChild(flag);
          const layout = marginFlagLayout(
            pageTextLeft,
            flag.getBoundingClientRect().width,
          );
          flag.style.left = `${layout.left}px`;
          flag.style.maxWidth = `${layout.maxWidth}px`;
          flag.style.boxSizing = "border-box";
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
      flag.textContent = abbreviateFlagLabel(name);
      flag.title = name;
      flag.setAttribute("aria-label", name);
      flag.setAttribute(
        "style",
        "position:fixed;" +
          "left:2px;" +
          `top:${Math.round(rc.top)}px;` +
          "background:#fff;color:#2e414f;" +
          "box-shadow:0 0 2px rgba(0,0,0,0.35);white-space:nowrap;" +
          "overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;",
      );
      // Track the reader's zoom, as on the PDF side.
      applyFlagScale(flag, pv.scale ?? 1, rl.color);
      layer.appendChild(flag);
      const block = rl.range.startContainer?.parentElement?.closest?.(
        "p,li,blockquote,dd,dt",
      );
      const textLeft = block?.getBoundingClientRect?.().left ?? rc.left;
      const layout = marginFlagLayout(
        textLeft,
        flag.getBoundingClientRect().width,
      );
      flag.style.left = `${layout.left}px`;
      flag.style.maxWidth = `${layout.maxWidth}px`;
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
