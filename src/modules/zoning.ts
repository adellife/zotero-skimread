/**
 * Document zoning: identify page furniture and the reference zone by document
 * statistics rather than per-page rules or per-language headings.
 *
 * Motivated by a measured failure: on one test paper, 8 of 36 highlights (22%)
 * were reference entries and a running header. The margin cut missed the header
 * because it sat inside the body area, and the reference headings table missed
 * the bibliography because heading text is language-specific.
 *
 * Two detectors, both pure functions over extracted PageText:
 * - Furniture: a line whose digit-stripped text repeats on many pages at a
 *   consistent height is a running header/footer, wherever it sits. Repetition
 *   is layout-independent, unlike margins.
 * - References: bibliography lines are dense in years, "et al.", DOIs, entry
 *   numbering and author initials. The longest contiguous high-density run at
 *   the document's end is the reference zone — same arithmetic in any language.
 */
import type { PageText } from "../reader/adapter";

export interface PageLine {
  /** [startChar, endChar) into PageText.chars */
  startChar: number;
  endChar: number;
  /** [startText, endText) into PageText.text */
  startText: number;
  endText: number;
  baseline: number;
  text: string;
}

export interface ZoneInfo {
  /** Furniture char ranges per pageIndex; sentences overlapping these drop. */
  furniture: Map<number, Array<[number, number]>>;
  /** Distinct repeated lines found (for the status readout). */
  furnitureLineCount: number;
  /** First page of the reference zone, -1 when none detected. */
  referenceStartPage: number;
}

// A line must recur on at least this many pages to count as furniture.
const MIN_REPEAT_PAGES = 3;
const REPEAT_PAGE_FRACTION = 0.3;
// Absolute vertical bands (PDF points). Pages within one document share a
// physical size, so absolute position is the right invariant: a header sits at
// the same baseline on every page. (Normalising against per-page content
// height fails — the topmost line of any page always lands in the top band.)
const Y_BAND_PT = 30;

// Signals that a line belongs to a bibliography. Each regex is one vote.
const REF_SIGNALS = [
  /\b(?:19|20)\d{2}\b/, // year
  /\bet al\b/i,
  /doi|arxiv|https?:\/\//i,
  /^\s*(?:\[\d+\]|\d{1,3}\.)\s/, // [12] / 12. entry numbering
  /[A-Z][a-z]+,\s*[A-Z]\./, // "Smith, J."
];
// A page joins the reference zone when at least half its substantial lines
// carry a signal, with an absolute floor so a sparse last page cannot qualify
// on two matching lines.
const REF_DENSITY = 0.5;
const REF_MIN_HITS = 5;

export function refSignalScore(text: string): number {
  let score = 0;
  for (const signal of REF_SIGNALS) if (signal.test(text)) score++;
  return score;
}

/** Cluster a page's chars into visual lines by baseline proximity. */
export function pageLines(page: PageText): PageLine[] {
  const lines: PageLine[] = [];
  if (!page.chars.length) return lines;
  // First text index for each char index (charMap maps text -> char).
  const textOfChar = new Array<number>(page.chars.length).fill(-1);
  for (let t = 0; t < page.charMap.length; t++) {
    const c = page.charMap[t];
    if (c >= 0 && textOfChar[c] < 0) textOfChar[c] = t;
  }
  let cur: {
    start: number;
    end: number;
    baseline: number;
    size: number;
  } | null = null;
  const flush = () => {
    if (!cur) return;
    const startText = textOfChar[cur.start] ?? 0;
    const lastText = textOfChar[cur.end - 1] ?? startText;
    lines.push({
      startChar: cur.start,
      endChar: cur.end,
      startText,
      endText: lastText + 1,
      baseline: cur.baseline,
      text: page.text.slice(startText, lastText + 1),
    });
  };
  for (let i = 0; i < page.chars.length; i++) {
    const ch = page.chars[i];
    if (cur && Math.abs(ch.baseline - cur.baseline) <= cur.size * 0.5) {
      cur.end = i + 1;
    } else {
      flush();
      cur = { start: i, end: i + 1, baseline: ch.baseline, size: ch.fontSize };
    }
  }
  flush();
  return lines;
}

/** Digit-stripped, whitespace-free key: page numbers vary, headers do not. */
function furnitureKey(text: string): string {
  return text.replace(/[\d\s]+/g, "").toLowerCase();
}

/**
 * Analyze a document's pages. Degrades to "nothing detected" on short or
 * unusual documents, which leaves behaviour exactly as before zoning existed.
 */
export function analyzeZones(pages: PageText[]): ZoneInfo {
  const zones: ZoneInfo = {
    furniture: new Map(),
    furnitureLineCount: 0,
    referenceStartPage: -1,
  };
  const paged = pages.filter((p) => p.chars.length > 0);
  if (paged.length < MIN_REPEAT_PAGES) return zones;

  const linesByPage = new Map<number, PageLine[]>();
  for (const page of paged) linesByPage.set(page.pageIndex, pageLines(page));

  // ---- furniture ----
  const occurrences = new Map<
    string,
    Array<{ pageIndex: number; yBucket: number; line: PageLine }>
  >();
  for (const page of paged) {
    const seenOnPage = new Set<string>();
    for (const line of linesByPage.get(page.pageIndex)!) {
      const key = furnitureKey(line.text);
      if (key.length < 5 || seenOnPage.has(key)) continue;
      seenOnPage.add(key);
      const yBucket = Math.round(line.baseline / Y_BAND_PT);
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key)!.push({ pageIndex: page.pageIndex, yBucket, line });
    }
  }
  const minPages = Math.max(
    MIN_REPEAT_PAGES,
    Math.ceil(paged.length * REPEAT_PAGE_FRACTION),
  );
  for (const occ of occurrences.values()) {
    if (occ.length < minPages) continue;
    const buckets = occ.map((o) => o.yBucket);
    if (Math.max(...buckets) - Math.min(...buckets) > 1) continue; // varying height: body text
    zones.furnitureLineCount++;
    for (const { pageIndex, line } of occ) {
      if (!zones.furniture.has(pageIndex)) zones.furniture.set(pageIndex, []);
      zones.furniture.get(pageIndex)!.push([line.startChar, line.endChar]);
    }
  }

  // ---- reference zone ----
  // Contiguous run of dense pages anchored at the end, so a trailing appendix
  // (which breaks the run) is not swallowed.
  let start = -1;
  for (let i = paged.length - 1; i >= 0; i--) {
    const lines = linesByPage
      .get(paged[i].pageIndex)!
      .filter((l) => l.text.trim().length > 10);
    const hits = lines.filter((l) => refSignalScore(l.text) >= 1).length;
    const dense =
      lines.length > 0 &&
      hits / lines.length >= REF_DENSITY &&
      hits >= REF_MIN_HITS;
    if (dense) start = i;
    else if (start >= 0) break; // run ended
  }
  if (start >= 0) zones.referenceStartPage = paged[start].pageIndex;
  return zones;
}

/** Whether a sentence's char range overlaps any furniture line on its page. */
export function overlapsFurniture(
  zones: ZoneInfo,
  pageIndex: number,
  startChar: number,
  endChar: number,
): boolean {
  const ranges = zones.furniture.get(pageIndex);
  if (!ranges) return false;
  for (const [s, e] of ranges) {
    if (startChar < e && endChar > s) return true;
  }
  return false;
}
