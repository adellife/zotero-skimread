/**
 * Skim highlighting pipeline with dynamic label sets.
 *
 * Label modes:
 * - "default": Goal/Method/Result/Novelty (Semantic Reader style)
 * - "custom": user-defined labels (settings pane, JSON)
 * - "auto": zero-shot — the model reads a sample of the document and
 *   proposes 3-6 labels suited to it (paper, book, chapter, report)
 *
 * Invariants: runs only on explicit user action; results are bound to the
 * originating reader; overlays are ephemeral by default; cache per (file,
 * model, labels, prompt version). Native Zotero annotations are created only
 * by the separate, explicit save action below.
 */

import { getPref } from "../utils/prefs";
import {
  chatJSON,
  contextLimitTokens,
  getTokenUsage,
  modelForProvider,
  providerLabel,
  resetTokenUsage,
} from "../llm/ollama";
import {
  PROMPT_VERSION,
  LabelDef,
  DEFAULT_LABELS,
  DISCOVER_SCHEMA,
  DISCOVER_SYSTEM,
  PALETTE,
  ADAPTIVE_SCHEMA,
  ADAPTIVE_SYSTEM,
  REDUCE_SCHEMA,
  REDUCE_SYSTEM,
  buildReducePrompt,
  validateReduce,
  buildAdaptiveSelectionPrompt,
  buildBandSelectionPrompt,
  buildDocumentSelectionPrompt,
  buildDocumentSelectionSchema,
  buildSkimSystem,
  buildTldrPrompt,
  parseCustomLabels,
  validateAdaptiveSelection,
  validateDiscovery,
  validateDocumentSelection,
  validateTldr,
  TLDR_SCHEMA,
  TLDR_SYSTEM,
} from "../prompts/skim";
import {
  extractPage,
  getPageCount,
  installOverlays,
  installEpubOverlays,
  isReaderAlive,
  HighlightSpec,
  OverlayController,
  PageText,
} from "../reader/adapter";
import { extractEpubSections } from "../reader/epub";
import { saveEpubHighlights, saveNativeHighlights } from "./annotations";
import { analyzeZones, overlapsFurniture, refSignalScore } from "./zoning";

/** Reader document type. EPUBs use a text-only (no-overlay) path. */
function isEpub(reader: any): boolean {
  return reader?.type === "epub";
}

// Zotero Item Types whose contents span shifting topics chapter to chapter and
// therefore benefit from adaptive per-chapter label discovery. Everything else
// (journalArticle, conferencePaper, preprint, …) is treated as a focused paper.
const BOOK_LIKE_TYPES = new Set([
  "book",
  "bookSection",
  "thesis",
  "report",
  "manuscript",
  "encyclopediaArticle",
  "dictionaryEntry",
]);

/** True when the attachment's (parent) Zotero Item Type reads as book-like. */
function isBookLikeItem(attachment: Zotero.Item): boolean {
  try {
    const parent = attachment.parentItem ?? attachment;
    const typeName = Zotero.ItemTypes.getName(parent.itemTypeID);
    return BOOK_LIKE_TYPES.has(typeName);
  } catch {
    return false;
  }
}

/**
 * Rebuild coarse per-page text from cached sentences, for the paths that only
 * need page *text* (label discovery). Used when extraction was reused from
 * cache and the full char geometry was never re-read.
 */
function sentencesAsPages(sentences: ExtractedSentence[]): PageText[] {
  const byPage = new Map<number, string[]>();
  for (const s of sentences) {
    if (!byPage.has(s.pageIndex)) byPage.set(s.pageIndex, []);
    byPage.get(s.pageIndex)!.push(s.text);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, parts]) => ({
      pageIndex,
      text: parts.join(" "),
      charMap: [],
      chars: [],
    }));
}

/** Wrap plain section text as a PageText with identity char offsets. */
function sectionAsPage(index: number, text: string): PageText {
  const charMap = Array.from({ length: text.length }, (_, i) => i);
  return { pageIndex: index, text, charMap, chars: [] };
}

export interface ClassifiedSentence {
  pageIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  label: string;
  confidence: number;
  /**
   * Kept by the reduce pass as part of the document's narrative. Core sentences
   * are shown first at any density; the rest fill the remaining slots, so the
   * density slider becomes "how much beyond the core story to show".
   */
  core?: boolean;
}

interface CachePayload {
  promptVersion: number;
  model: string;
  labels: LabelDef[];
  sentences: ClassifiedSentence[];
  /** false while a run is still in progress / was interrupted */
  complete: boolean;
  /** how many of the segmented sentences have been classified so far */
  classifiedCount: number;
  /** token budget used to compute chunk boundaries; kept stable for resume */
  chunkBudget?: number;
  /** Keys created by the explicit “Save as Zotero annotations” action. */
  savedAnnotationKeys?: string[];
  /** Cached TL;DR summary from the explicit “TL;DR” action. */
  tldr?: string;
  /** Number of body pages that had candidate sentences (coverage denominator). */
  pageSpan?: number;
  /** Cumulative tokens spent producing this run (input/read and output). */
  tokensInput?: number;
  tokensOutput?: number;
  /**
   * Extracted + section-processed sentences. Persisted so a paused run resumes
   * straight into selection instead of re-reading the whole document — the slow
   * part of a long PDF, and pure wasted time on resume.
   */
  extracted?: ExtractedSentence[];
  extractComplete?: boolean;
  /** Whether the whole-document reduce pass has already run for this payload. */
  reduced?: boolean;
  /** How many candidates it kept as the narrative core (0 if it failed). */
  coreCount?: number;
}

interface JobState {
  running: boolean;
  cancelled: boolean;
  overlay: OverlayController | null;
  pageCache: Map<number, PageText>;
  itemID: number;
}

interface ExtractedSentence {
  pageIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  section: DocumentSection;
}

type DocumentSection =
  | "front matter"
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "appendix"
  | "references"
  | "body";

const jobs = new Map<string, JobState>(); // key = reader tabID

const MIN_LEN = 40;
// Humanities/French sentences run long; keep them as candidates instead of
// dropping. Over-long segments are split at clause boundaries (splitLongSegment).
const MAX_LEN = 800;
const DISCOVERY_SAMPLE_CHARS = 6000;
const MAX_HIGHLIGHTS_PER_PAGE = 10;
const CONTEXT_RESERVE_TOKENS = 6000;

export type LabelMode = "default" | "custom" | "auto";

export function getLabelMode(): LabelMode {
  const m = String(getPref("labelMode") || "default");
  return m === "custom" || m === "auto" ? m : "default";
}

/** Labels for default/custom modes; null for auto (discovered per document). */
export function getConfiguredLabels(): LabelDef[] | null {
  const mode = getLabelMode();
  if (mode === "auto") return null;
  if (mode === "custom") {
    const parsed = parseCustomLabels(String(getPref("customLabels") || ""));
    if (parsed) return parsed;
  }
  return DEFAULT_LABELS;
}

function hiddenLabelKeys(): Set<string> {
  try {
    const arr = JSON.parse(String(getPref("hiddenLabels") || "[]"));
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

// ---------- cache ----------

async function cacheDir(): Promise<string> {
  const dir = PathUtils.join(Zotero.DataDirectory.dir, "skimread-cache");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // Zotero's DOM WebCrypto accepts Uint8Array. The bundled Node declarations
  // describe a nominally different BufferSource, so keep that type boundary
  // local rather than weakening the cache API.
  const hash = await crypto.subtle.digest("SHA-256", bytes as never);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function cacheKey(attachment: Zotero.Item): Promise<string> {
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("Attachment file is unavailable for caching");
  const fileHash = await sha256(await IOUtils.read(path));
  const model = modelForProvider(String(getPref("skimModel")));
  const mode = getLabelMode();
  const labels = getConfiguredLabels();
  const labelSig =
    mode === "auto" ? "auto" : labels!.map((l) => l.key).join(",");
  const raw = `${fileHash}|${providerLabel()}|${model}|${mode}|${labelSig}|v${PROMPT_VERSION}`;
  return sha256(new TextEncoder().encode(raw));
}

async function cacheRead(key: string): Promise<CachePayload | null> {
  try {
    const file = PathUtils.join(await cacheDir(), `${key}.json`);
    if (!(await IOUtils.exists(file))) return null;
    const payload = JSON.parse(await IOUtils.readUTF8(file)) as CachePayload;
    if (payload.promptVersion !== PROMPT_VERSION) return null;
    if (!Array.isArray(payload.labels)) return null;
    if (typeof payload.complete !== "boolean") payload.complete = true;
    if (typeof payload.classifiedCount !== "number") {
      payload.classifiedCount = payload.sentences.length;
    }
    return payload;
  } catch {
    return null;
  }
}

async function cacheWrite(key: string, payload: CachePayload): Promise<void> {
  const file = PathUtils.join(await cacheDir(), `${key}.json`);
  await IOUtils.writeUTF8(file, JSON.stringify(payload));
}

async function cacheDelete(key: string): Promise<void> {
  try {
    await IOUtils.remove(PathUtils.join(await cacheDir(), `${key}.json`), {
      ignoreAbsent: true,
    });
  } catch {
    // ignore
  }
}

export type CacheState = "none" | "partial" | "complete";

export async function cacheState(attachment: Zotero.Item): Promise<CacheState> {
  const payload = await cacheRead(await cacheKey(attachment));
  if (!payload) return "none";
  return payload.complete ? "complete" : "partial";
}

export async function hasCachedRun(attachment: Zotero.Item): Promise<boolean> {
  return (await cacheState(attachment)) !== "none";
}

export interface CacheSummary {
  state: CacheState;
  /** highlights kept (confidence >= 0.5, real label) */
  selections: number;
  /** sentences the model has looked at so far */
  considered: number;
  /** distinct pages that received a highlight */
  pagesCovered: number;
  /** body pages that had candidate sentences */
  pageSpan: number;
  tokensInput: number;
  tokensOutput: number;
  /** candidates the reduce pass kept as the document's narrative core */
  coreCount: number;
}

/** Persistent run summary for the sidebar's idle status line. */
export async function cacheSummary(
  attachment: Zotero.Item,
): Promise<CacheSummary> {
  const payload = await cacheRead(await cacheKey(attachment));
  if (!payload) {
    return {
      state: "none",
      selections: 0,
      considered: 0,
      pagesCovered: 0,
      pageSpan: 0,
      tokensInput: 0,
      tokensOutput: 0,
      coreCount: 0,
    };
  }
  const kept = payload.sentences.filter(
    (sentence) => sentence.label !== "none" && sentence.confidence >= 0.5,
  );
  return {
    state: payload.complete ? "complete" : "partial",
    selections: kept.length,
    considered: payload.classifiedCount,
    pagesCovered: new Set(kept.map((s) => s.pageIndex)).size,
    pageSpan: payload.pageSpan || 0,
    tokensInput: payload.tokensInput || 0,
    tokensOutput: payload.tokensOutput || 0,
    coreCount: kept.filter((s) => s.core).length,
  };
}

export async function getCachedLabels(
  attachment: Zotero.Item,
): Promise<LabelDef[] | null> {
  return (await cacheRead(await cacheKey(attachment)))?.labels ?? null;
}

/** Selected highlights (density- and label-filtered) for the EPUB sidebar list. */
export async function getCachedHighlights(
  attachment: Zotero.Item,
): Promise<HighlightSpec[]> {
  const payload = await cacheRead(await cacheKey(attachment));
  if (!payload?.complete) return [];
  const density = Number(getPref("highlightDensity")) || 3;
  return selectTopPerPage(payload.sentences, payload.labels, density);
}

/** Whether this exact cached skim run has already been saved to Zotero. */
export async function hasSavedAnnotations(
  attachment: Zotero.Item,
): Promise<boolean> {
  const payload = await cacheRead(await cacheKey(attachment));
  return !!payload?.savedAnnotationKeys?.length;
}

// ---------- segmentation ----------

/** Map a page.text [startText, endText) span to a candidate sentence. */
// An author byline carries affiliation superscripts that extract as digits glued
// to the surname ("Jurgens2,4", "Aiello1,5"). On a title page the byline usually
// runs straight into the abstract with no sentence-ending punctuation, so the
// segmenter hands back one span that begins with author names — and highlighting
// it starts the highlight on the authors.
const BYLINE_TOKEN = /[A-Z][A-Za-z'’-]+\d[\d,]*/g;

/**
 * Offset at which real prose begins, if this span opens with an author byline.
 * Returns 0 when it does not. Trimming rather than dropping keeps the abstract
 * sentence the byline is glued to, which is usually worth highlighting.
 */
function bylineTrimOffset(text: string): number {
  const head = text.slice(0, 240);
  BYLINE_TOKEN.lastIndex = 0;
  let matches = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = BYLINE_TOKEN.exec(head))) {
    // Only a run starting at the very beginning of the span is a byline; a
    // "Smith2020 argued" mid-prose must not trigger this.
    if (m.index > 140) break;
    matches++;
    end = m.index + m[0].length;
  }
  // Two or more superscripted names is the signal; one could be a citation.
  if (matches < 2 || end < 0) return 0;
  // Skip the separators that follow the last author.
  const rest = text.slice(end);
  const lead = rest.match(/^[\s,;&]*(?:and\s+)?/);
  return end + (lead ? lead[0].length : 0);
}

// A section heading carries no terminal punctuation, so the segmenter fuses it
// to the sentence that follows: "Results Across all metrics…". Such a span reads
// like a section summary and is picked far more often than it deserves —
// measured on one paper, 5 of 6 such candidates were selected, 14x their share
// of the pool — spending the highlight budget on signposts instead of claims.
// Case-sensitive on purpose: headings are capitalised, and the [A-Z] guards
// below stop working under /i (which makes [A-Z] match lowercase too).
const LEADING_HEADING =
  /^(?:Phase\s*\d+\s*[:.]?|(?:Results?|Methods?|Methodology|Findings?|Discussion|Conclusions?|Introduction|Background|Abstract|Limitations?)(?:\s+(?:for|of|to|in)\s+(?:the\s+)?[A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,2})?)\s*[:.]?\s+(?=[A-Z])/;

/** Length of a section heading fused to the start of this span, else 0. */
function headingTrimOffset(text: string): number {
  const m = LEADING_HEADING.exec(text);
  if (!m) return 0;
  // "Results show that…" is a real sentence, not a heading: require what
  // follows to begin a new sentence rather than continue this one.
  const rest = text.slice(m[0].length);
  if (!/^[A-Z]/.test(rest)) return 0;
  return m[0].length;
}

function pushSpan(
  page: PageText,
  out: Omit<ExtractedSentence, "pageIndex" | "section">[],
  startText: number,
  endText: number,
): void {
  const raw = page.text.slice(startText, endText);
  const leadingWs = raw.length - raw.trimStart().length;
  let text = raw.trim();
  if (text.length < MIN_LEN || !/[a-zA-Z]{3}/.test(text)) return;
  // Title pages only: elsewhere a leading capitalised-name-plus-digits run is
  // far more likely to be prose than a byline.
  let removedFront = 0;
  if (page.pageIndex === 0) {
    const skip = bylineTrimOffset(text);
    if (skip > 0) {
      const kept = text.slice(skip).trimStart();
      // If nothing substantial follows, the span was byline all the way down.
      if (kept.length < MIN_LEN) return;
      removedFront += text.length - kept.length;
      text = kept;
    }
  }
  // Section headings fuse to the following sentence anywhere in the document.
  const headSkip = headingTrimOffset(text);
  if (headSkip > 0) {
    const kept = text.slice(headSkip).trimStart();
    if (kept.length >= MIN_LEN) {
      removedFront += text.length - kept.length;
      text = kept;
    }
  }
  // Advance the text offset by exactly what was removed, so the char range
  // (and therefore the painted rectangle) starts at the prose.
  if (removedFront > 0) startText += leadingWs + removedFront;
  let startChar = -1;
  let endChar = -1;
  for (let i = startText; i < endText && i < page.charMap.length; i++) {
    if (page.charMap[i] >= 0) {
      if (startChar < 0) startChar = page.charMap[i];
      endChar = page.charMap[i] + 1;
    }
  }
  if (startChar >= 0 && endChar > startChar) {
    out.push({ startChar, endChar, text });
  }
}

/**
 * Cut an over-long segment (a genuinely long sentence, or a run-on produced by
 * column/reading-order jumble) into clause-sized pieces so its content still
 * becomes candidates instead of being dropped. Offsets are relative to `base`.
 */
function splitLongSegment(
  page: PageText,
  out: Omit<ExtractedSentence, "pageIndex" | "section">[],
  base: number,
  text: string,
): void {
  const boundary = /[.;:!?»)]\s+/g;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text))) cuts.push(m.index + m[0].length);
  cuts.push(text.length);
  let start = 0;
  for (const cut of cuts) {
    if (cut - start >= MAX_LEN * 0.6) {
      pushSpan(page, out, base + start, base + cut);
      start = cut;
    }
  }
  if (text.length - start >= MIN_LEN) {
    pushSpan(page, out, base + start, base + text.length);
  }
}

function segmentSentences(
  page: PageText,
): Omit<ExtractedSentence, "pageIndex" | "section">[] {
  const out: Omit<ExtractedSentence, "pageIndex" | "section">[] = [];
  if (!page.text) return out;
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const s of seg.segment(page.text)) {
    const raw = s.segment;
    const trimmed = raw.trim();
    if (trimmed.length < MIN_LEN || !/[a-zA-Z]{3}/.test(trimmed)) continue;
    const base = s.index + (raw.length - raw.trimStart().length);
    if (trimmed.length <= MAX_LEN) {
      pushSpan(page, out, base, base + trimmed.length);
    } else {
      splitLongSegment(page, out, base, trimmed);
    }
  }
  return out;
}

// Multilingual (EN/FR/ES/DE/IT) heading markers. Only "references" causes text
// to be dropped, so it is kept tight; the others are context hints and can be
// liberal without harm.
// Right-to-left headings (Persian, Arabic) need their own entries: JS \b is
// defined over [A-Za-z0-9_], so it never matches at an Arabic-script boundary
// and every \b-anchored pattern above silently fails on these documents.
const RTL_SECTION_MARKERS: [RegExp, DocumentSection][] = [
  [
    /(?:منابع|مراجع|مآخذ|ك?کتاب\s*نامه|فهرست\s*(?:منابع|مراجع)|المصادر|المراجع)/,
    "references",
  ],
  [/(?:پیوست|ضمیمه|پيوست|الملاحق|الملحق)/, "appendix"],
  [/(?:چکیده|چكيده|الملخص|ملخص)/, "abstract"],
  [/(?:مقدمه|درآمد|المقدمة)/, "introduction"],
  [/(?:روش\s*(?:شناسی|شناسي|تحقیق|پژوهش)?|المنهجية|منهج\s*البحث)/, "methods"],
  [/(?:یافته\s*ها|يافته\s*ها|نتایج|نتايج|النتائج)/, "results"],
  [/(?:بحث\s*و\s*بررسی|بحث|المناقشة)/, "discussion"],
  [/(?:نتیجه\s*گیری|نتيجه\s*گيري|جمع\s*بندی|الخاتمة|الاستنتاج)/, "conclusion"],
];

const SECTION_MARKERS: [RegExp, DocumentSection][] = [
  [
    /\b(?:references|bibliography|works cited|literature cited|cited literature|reference list|r[ée]f[ée]rences?|bibliographie|ouvrages cit[ée]s|litt[ée]rature cit[ée]e|bibliograf(?:y|ía|ia)|referencias|literaturverzeichnis|riferimenti bibliografici)\b/i,
    "references",
  ],
  [
    /\b(?:appendix|supplementary materials?|annexes?|appendice|anhang)\b/i,
    "appendix",
  ],
  [
    /\b(?:abstract|summary|r[ée]sum[ée]|resumen|zusammenfassung|riassunto)\b/i,
    "abstract",
  ],
  [
    /\b(?:introduction|background|introducci[óo]n|einleitung|introduzione)\b/i,
    "introduction",
  ],
  [
    /\b(?:materials? and methods?|methods?|methodology|experimental setup|m[ée]thodes?|m[ée]thodologie|mat[ée]riel et m[ée]thodes|corpus|metodolog[íi]a|methoden|metodi)\b/i,
    "methods",
  ],
  [
    /\b(?:results?|findings?|r[ée]sultats?|resultados|ergebnisse|risultati)\b/i,
    "results",
  ],
  [
    /\b(?:discussion|analys[ei]s|analyse|discusi[óo]n|diskussion|discussione)\b/i,
    "discussion",
  ],
  [
    /\b(?:conclusions?|concluding remarks?|conclusi[óo]n|schluss|fazit|conclusione)\b/i,
    "conclusion",
  ],
];

/**
 * Infer a coarse document role from a heading at the very top of a page. The
 * role is context for the selector; only "references" gates dropping, so the
 * window is kept short (headings sit at the top) to avoid catching body text.
 */
function sectionAtPageStart(page: PageText): DocumentSection | null {
  const lead = page.text.slice(0, 160);
  for (const [marker, section] of SECTION_MARKERS) {
    if (marker.test(lead)) return section;
  }
  // Only worth scanning when the page actually contains Arabic-script text.
  if (/[؀-ۿ]/.test(lead)) {
    for (const [marker, section] of RTL_SECTION_MARKERS) {
      if (marker.test(lead)) return section;
    }
  }
  return null;
}

// A title/author/affiliation line is short; running prose is long. The first
// long sentence marks where the body begins.
const FRONT_MATTER_MAX_LEN = 120;

/**
 * Attach the active paper section to each sentence, carrying headings forward.
 * Default is "body" (not "front matter") so that a paper with no early heading
 * — common in the humanities — is never wholly discarded. Only the leading
 * short lines on the first page (title, authors, affiliations) are treated as
 * front matter.
 */
function withDocumentSections(
  pages: PageText[],
  sentences: ExtractedSentence[],
): typeof sentences {
  const sections = new Map<number, DocumentSection>();
  let active: DocumentSection = "body";
  for (const p of pages) {
    const detected = sectionAtPageStart(p);
    if (detected) active = detected;
    sections.set(p.pageIndex, active);
  }
  const out = sentences.map((sentence) => ({
    ...sentence,
    section: sections.get(sentence.pageIndex) || "body",
  }));
  // Mark the page-0 title/author block: leading short sentences up to the first
  // running-prose sentence. Sentences are ordered page-then-position.
  for (const sentence of out) {
    if (sentence.pageIndex !== 0) break;
    if (sentence.text.length >= FRONT_MATTER_MAX_LEN) break;
    sentence.section = "front matter";
  }
  return out;
}

/**
 * Reference lists and front matter (title, author block, journal banner) are
 * never candidates — highlighting the paper's own title helps nobody.
 * Full-context selection never silently truncates the main paper: callers
 * separately check the provider budget.
 */
function limitWork(sentences: ExtractedSentence[]): ExtractedSentence[] {
  const filtered = sentences.filter(
    (sentence) =>
      sentence.section !== "references" && sentence.section !== "front matter",
  );
  // Never filter a document down to nothing — better to consider everything
  // than to complete a run with zero candidates.
  return filtered.length ? filtered : sentences;
}

// ---------- zero-shot label discovery ----------

async function discoverLabels(
  pages: PageText[],
  onStatus: (msg: string) => void,
): Promise<LabelDef[] | null> {
  onStatus("Reading document to propose labels…");
  // sample: front matter + a slice from the middle + the end
  const texts = pages.map((p) => p.text).filter(Boolean);
  const whole = texts.join("\n");
  const head = whole.slice(0, DISCOVERY_SAMPLE_CHARS * 0.6);
  const mid = whole.slice(
    Math.floor(whole.length / 2),
    Math.floor(whole.length / 2) + DISCOVERY_SAMPLE_CHARS * 0.2,
  );
  const tail = whole.slice(-DISCOVERY_SAMPLE_CHARS * 0.2);
  const sample = `${head}\n[...]\n${mid}\n[...]\n${tail}`;
  const model = modelForProvider(
    String(getPref("tldrModel") || getPref("skimModel")),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await chatJSON({
        model,
        system: DISCOVER_SYSTEM,
        user: `Document sample:\n\n${sample}`,
        schema: DISCOVER_SCHEMA,
      });
      const labels = validateDiscovery(raw);
      if (labels) return labels;
    } catch (e) {
      ztoolkit.log("skimread discovery error", e);
    }
  }
  return null;
}

// ---------- classification ----------

function estimateTokens(sentences: ExtractedSentence[]): number {
  // Deliberately conservative for mixed punctuation, references, and non-English
  // text. Prompt/schema overhead is covered by CONTEXT_RESERVE_TOKENS.
  return Math.ceil(
    sentences.reduce(
      (total, sentence) => total + sentence.text.length + 20,
      0,
    ) / 3.5,
  );
}

/**
 * Sentence-token budget per selection call. The prompt/schema/output reserve
 * scales down for small local contexts (never more than 40% of the window)
 * and the result is floored so a misconfigured context still makes progress.
 */
export function selectionBudget(): number {
  const limit = contextLimitTokens();
  const reserve = Math.min(CONTEXT_RESERVE_TOKENS, Math.floor(limit * 0.4));
  return Math.max(1024, limit - reserve);
}

/**
 * Split the document into the fewest context-sized chunks, preferring to cut
 * where the section changes (chapter boundaries in books) and otherwise at
 * page breaks, so each model call still sees a coherent stretch of text.
 * A short paper stays a single chunk — identical to the pre-chunking design.
 */
export function chunkSentences(
  sentences: ExtractedSentence[],
  budgetTokens: number,
): ExtractedSentence[][] {
  const chunks: ExtractedSentence[][] = [];
  let current: ExtractedSentence[] = [];
  let currentTokens = 0;
  let lastBoundary = 0; // index in `current` of the most recent section/page change

  for (const sentence of sentences) {
    const cost = estimateTokens([sentence]);
    const prev = current[current.length - 1];
    if (
      prev &&
      (prev.section !== sentence.section ||
        prev.pageIndex !== sentence.pageIndex)
    ) {
      lastBoundary = current.length;
    }
    if (current.length && currentTokens + cost > budgetTokens) {
      // Cut at the last natural boundary when it is not too early in the
      // chunk; otherwise cut right here.
      const cut =
        lastBoundary > current.length * 0.4 ? lastBoundary : current.length;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
      currentTokens = estimateTokens(current);
      lastBoundary = 0;
    }
    current.push(sentence);
    currentTokens += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function selectDocument(
  labels: LabelDef[],
  sentences: ExtractedSentence[],
  isCancelled: () => boolean,
): Promise<ClassifiedSentence[]> {
  const model = modelForProvider(String(getPref("skimModel")));
  const estimate = estimateTokens(sentences);
  // Defensive: chunkSentences() sizes chunks to this same budget, so this
  // only triggers if a caller bypasses chunking. 1.2 allows the greedy
  // chunker's boundary-preserving overshoot.
  if (estimate > selectionBudget() * 1.2) {
    throw new Error(
      `Chunk needs about ${estimate.toLocaleString()} tokens, but ${providerLabel()} is configured for ${contextLimitTokens().toLocaleString()}.`,
    );
  }
  const system = buildSkimSystem(labels);
  const schema = buildDocumentSelectionSchema(labels);
  const user = buildDocumentSelectionPrompt(
    sentences.map((sentence, id) => ({ ...sentence, id })),
    MAX_HIGHLIGHTS_PER_PAGE,
    labels,
  );
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return [];
    try {
      const raw = await chatJSON({
        model,
        system,
        user:
          (attempt
            ? "Your previous response did not match the required schema or used invalid IDs. Return only valid JSON.\n\n"
            : "") + user,
        schema,
      });
      const selected = validateDocumentSelection(raw, labels, sentences.length);
      if (!selected) {
        lastError = "response did not match the required schema";
        continue;
      }
      return selected.map((result) => ({
        ...sentences[result.id],
        label: result.label,
        confidence: result.importance,
      }));
    } catch (error) {
      // Surface the provider's own message (e.g. an unknown model id or a
      // login prompt) instead of hiding it behind a generic failure.
      lastError = String((error as Error)?.message || error);
      ztoolkit.log("skimread document selection error", error);
    }
  }
  throw new Error(
    lastError
      ? `${providerLabel()} selection failed: ${lastError.slice(0, 160)}`
      : "Model could not return a valid full-document selection",
  );
}

// ---------- adaptive (evolving) label selection ----------

const MAX_AUTO_LABELS = 8;

function slugLabel(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .slice(0, 12) || "topic"
  );
}

/**
 * Resolve a model-proposed label to a stable key, growing the shared label set
 * up to a cap. Near-duplicates and overflow map onto the closest existing label.
 */
function reconcileLabel(labels: LabelDef[], raw: string): string {
  const key = slugLabel(raw);
  const lower = raw.trim().toLowerCase();
  const existing = labels.find(
    (l) => l.key === key || l.name.toLowerCase() === lower,
  );
  if (existing) return existing.key;
  if (labels.length < MAX_AUTO_LABELS) {
    const name = raw
      .trim()
      .slice(0, 24)
      .replace(/^./, (c) => c.toUpperCase());
    labels.push({
      key,
      name,
      color: PALETTE[labels.length % PALETTE.length],
      description: name,
    });
    return key;
  }
  // Cap reached: fold into the closest existing label, else the first.
  const near = labels.find((l) => key.includes(l.key) || l.key.includes(key));
  return (near || labels[0]).key;
}

/**
 * Select + label one passage, allowing the model to reuse the evolving label
 * set or introduce a new label. Mutates `labels` in place as labels emerge.
 */
async function selectBandAdaptive(
  labels: LabelDef[],
  band: ExtractedSentence[],
  targetCount: number,
  isCancelled: () => boolean,
): Promise<ClassifiedSentence[]> {
  const model = modelForProvider(String(getPref("skimModel")));
  const user = buildAdaptiveSelectionPrompt(
    band.map((sentence, id) => ({ id, text: sentence.text })),
    targetCount,
    labels,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return [];
    try {
      const raw = await chatJSON({
        model,
        system: ADAPTIVE_SYSTEM,
        user: (attempt ? "Return only valid JSON.\n\n" : "") + user,
        schema: ADAPTIVE_SCHEMA,
      });
      const selected = validateAdaptiveSelection(raw, band.length);
      if (!selected) continue;
      return selected.map((result) => ({
        ...band[result.id],
        label: reconcileLabel(labels, result.label),
        confidence: result.importance,
      }));
    } catch (error) {
      ztoolkit.log("skimread adaptive selection error", error);
    }
  }
  return [];
}

// ---------- hierarchical (map-reduce) selection ----------

/**
 * Select ~targetCount sentences from a single passage. Returns [] on failure
 * so one weak band never aborts the whole run.
 */
async function selectBand(
  labels: LabelDef[],
  band: ExtractedSentence[],
  targetCount: number,
  isCancelled: () => boolean,
): Promise<ClassifiedSentence[]> {
  const model = modelForProvider(String(getPref("skimModel")));
  const system = buildSkimSystem(labels);
  const schema = buildDocumentSelectionSchema(labels);
  const user = buildBandSelectionPrompt(
    band.map((sentence, id) => ({ ...sentence, id })),
    targetCount,
    labels,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return [];
    try {
      const raw = await chatJSON({
        model,
        system,
        user:
          (attempt
            ? "Your previous response was invalid JSON. Return only valid JSON.\n\n"
            : "") + user,
        schema,
      });
      const selected = validateDocumentSelection(raw, labels, band.length);
      if (!selected) continue;
      return selected.map((result) => ({
        ...band[result.id],
        label: result.label,
        confidence: result.importance,
      }));
    } catch (error) {
      ztoolkit.log("skimread band selection error", error);
    }
  }
  return [];
}

/**
 * Split the ordered sentences into contiguous bands of roughly equal size, so
 * each band is processed on its own and the whole document is covered. Bands
 * that exceed the context budget are sub-split.
 */
export function splitIntoBands(
  sentences: ExtractedSentence[],
  bandCount: number,
  budgetTokens: number,
): ExtractedSentence[][] {
  if (sentences.length === 0) return [];
  const perBand = Math.ceil(sentences.length / Math.max(1, bandCount));
  const out: ExtractedSentence[][] = [];
  for (let i = 0; i < sentences.length; i += perBand) {
    const group = sentences.slice(i, i + perBand);
    if (estimateTokens(group) <= budgetTokens) out.push(group);
    else out.push(...chunkSentences(group, budgetTokens));
  }
  return out;
}

// ---------- selection & painting ----------

/** Count kept highlights per label key (conf >= 0.5), for the sidebar. */
export function countByLabel(
  sentences: ClassifiedSentence[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sentences) {
    if (s.label === "none" || s.confidence < 0.5) continue;
    counts[s.label] = (counts[s.label] || 0) + 1;
  }
  return counts;
}

/**
 * Reduce pass: the only step that sees the whole document's candidates at once.
 * Marks the subset that narrates the paper as `core`, dropping restatements.
 *
 * Failure is non-fatal by design — if the model errors or returns nothing
 * usable, every candidate simply stays uncored and the run behaves exactly as
 * it did before this pass existed.
 */
async function reducePass(
  sentences: ClassifiedSentence[],
  pageSpan: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (sentences.length < 6) return false; // nothing to consolidate
  const model = modelForProvider(String(getPref("skimModel")));
  const targetCount = Math.max(4, Math.min(24, Math.round(pageSpan * 1.2)));
  const candidates = sentences.map((s, id) => ({
    id,
    pageIndex: s.pageIndex,
    label: s.label,
    text: s.text,
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return false;
    try {
      const raw = await chatJSON({
        model,
        system: REDUCE_SYSTEM,
        user:
          (attempt
            ? "Your previous response did not match the required schema. Return only valid JSON.\n\n"
            : "") + buildReducePrompt(candidates, targetCount),
        schema: REDUCE_SCHEMA,
      });
      const kept = validateReduce(raw, candidates.length);
      if (!kept?.length) continue;
      for (const { id, importance } of kept) {
        sentences[id].core = true;
        sentences[id].confidence = Math.max(
          sentences[id].confidence,
          importance,
        );
      }
      return true;
    } catch (e) {
      ztoolkit.log("skimread reduce error", e);
    }
  }
  return false;
}

function selectTopPerPage(
  all: ClassifiedSentence[],
  labels: LabelDef[],
  density: number,
): HighlightSpec[] {
  const hidden = hiddenLabelKeys();
  const byKey = new Map(labels.map((l) => [l.key, l]));
  const byPage = new Map<number, ClassifiedSentence[]>();
  for (const s of all) {
    if (s.label === "none" || s.confidence < 0.5) continue;
    if (hidden.has(s.label) || !byKey.has(s.label)) continue;
    if (!byPage.has(s.pageIndex)) byPage.set(s.pageIndex, []);
    byPage.get(s.pageIndex)!.push(s);
  }
  const specs: HighlightSpec[] = [];
  for (const list of byPage.values()) {
    // Core (narrative) sentences first, then the rest by confidence, so raising
    // density adds context around the story rather than reshuffling it.
    list.sort(
      (a, b) =>
        Number(!!b.core) - Number(!!a.core) || b.confidence - a.confidence,
    );
    for (const s of list.slice(0, density)) {
      const def = byKey.get(s.label)!;
      specs.push({
        pageIndex: s.pageIndex,
        startChar: s.startChar,
        endChar: s.endChar,
        colorRGB: def.color,
        label: def.name,
        text: s.text,
      });
    }
  }
  return specs;
}

/**
 * Save the currently visible (density- and label-filtered) overlays as
 * standard Zotero highlight annotations. This is never called automatically.
 */
export async function saveSkimAsAnnotations(
  reader: any,
  attachment: Zotero.Item,
): Promise<{ saved: number; alreadySaved: boolean; skipped?: number }> {
  const key = await cacheKey(attachment);
  const payload = await cacheRead(key);
  if (!payload?.complete) {
    throw new Error("Generate skim highlights before saving them to Zotero");
  }
  if (payload.savedAnnotationKeys?.length) {
    return { saved: payload.savedAnnotationKeys.length, alreadySaved: true };
  }
  const density = Number(getPref("highlightDensity")) || 3;
  const specs = selectTopPerPage(payload.sentences, payload.labels, density);
  if (!specs.length) {
    throw new Error("There are no visible highlights to save");
  }

  // EPUBs are positioned by CFI, produced from live DOM ranges, so only
  // currently-rendered sections can be converted.
  if (isEpub(reader)) {
    const { saved, skipped } = await saveEpubHighlights(
      attachment,
      reader,
      specs,
    );
    if (!saved.length) {
      throw new Error(
        "Could not locate the highlighted text in the book. Scroll through the chapters once, then try again",
      );
    }
    payload.savedAnnotationKeys = saved;
    await cacheWrite(key, payload);
    return { saved: saved.length, alreadySaved: false, skipped };
  }

  const pages = new Map<number, PageText>();
  for (const pageIndex of new Set(specs.map((spec) => spec.pageIndex))) {
    const page = await extractPage(reader, pageIndex);
    if (page) pages.set(pageIndex, page);
  }
  const keys = await saveNativeHighlights(attachment, specs, pages);
  if (!keys.length) {
    throw new Error("Could not map the selected text to PDF coordinates");
  }
  payload.savedAnnotationKeys = keys;
  await cacheWrite(key, payload);
  return { saved: keys.length, alreadySaved: false };
}

// ---------- TL;DR summary ----------

const TLDR_INPUT_CHARS = 14000; // title + lead of the paper, kept well within context

/** Return an already-cached TL;DR without contacting the model. */
export async function getCachedTldr(
  attachment: Zotero.Item,
): Promise<string | null> {
  return (await cacheRead(await cacheKey(attachment)))?.tldr ?? null;
}

/** One structured summarization call (with a single repair retry). */
async function summarizeText(
  title: string,
  text: string,
  model: string,
): Promise<string> {
  let tldr: string | null = null;
  for (let attempt = 0; attempt < 2 && !tldr; attempt++) {
    try {
      const raw = await chatJSON({
        model,
        system: TLDR_SYSTEM,
        user:
          (attempt ? "Return only valid JSON matching the schema.\n\n" : "") +
          buildTldrPrompt(title, text),
        schema: TLDR_SCHEMA,
      });
      tldr = validateTldr(raw);
    } catch (error) {
      ztoolkit.log("skimread tldr error", error);
    }
  }
  if (!tldr)
    throw new Error(`${providerLabel()} did not return a usable TL;DR`);
  return tldr;
}

/** Collect the leading text of a paper, reusing already-extracted pages. */
function leadingText(
  reader: any,
  attachment: Zotero.Item,
  cachedPages?: Map<number, PageText>,
): Promise<string> {
  return (async () => {
    if (isEpub(reader)) {
      const sections = await extractEpubSections(attachment);
      return sections
        .map((s) => s.text)
        .join("\n")
        .slice(0, TLDR_INPUT_CHARS)
        .trim();
    }
    let text = "";
    const pageCount = getPageCount(reader);
    for (let p = 0; p < pageCount && text.length < TLDR_INPUT_CHARS; p++) {
      if (!isReaderAlive(reader)) throw new Error("Paper was closed");
      const page = cachedPages?.get(p) ?? (await extractPage(reader, p));
      if (page?.text) text += page.text + "\n";
    }
    return text.slice(0, TLDR_INPUT_CHARS).trim();
  })();
}

async function persistTldr(
  key: string,
  attachment: Zotero.Item,
  tldr: string,
): Promise<void> {
  let payload = await cacheRead(key);
  if (!payload) {
    payload = {
      promptVersion: PROMPT_VERSION,
      model: modelForProvider(String(getPref("skimModel"))),
      labels: getConfiguredLabels() ?? DEFAULT_LABELS,
      sentences: [],
      complete: false,
      classifiedCount: 0,
    };
  }
  payload.tldr = tldr;
  await cacheWrite(key, payload);
}

/**
 * Generate a short TL;DR of the paper with the configured TL;DR model. Uses
 * the document's title and leading text (abstract/intro), never fabricating
 * content. Result is cached alongside the skim run; `force` re-summarizes.
 */
export async function generateTldr(
  reader: any,
  attachment: Zotero.Item,
  onStatus: (msg: string) => void,
  force = false,
): Promise<string> {
  const key = await cacheKey(attachment);
  const existing = await cacheRead(key);
  if (!force && existing?.tldr) return existing.tldr;

  onStatus("Reading document…");
  const text = await leadingText(reader, attachment);
  if (!text) throw new Error("No extractable text (scanned PDF?)");
  const title = String(attachment.getField("title") || "").trim();
  const model = modelForProvider(
    String(getPref("tldrModel") || getPref("skimModel")),
  );
  onStatus("Summarizing…");
  const tldr = await summarizeText(title, text, model);
  await persistTldr(key, attachment, tldr);
  return tldr;
}

/**
 * Save the current TL;DR as a Zotero note attached to the paper. This is an
 * explicit user action — the only place, besides annotation export, where the
 * plugin writes to the library.
 */
export async function saveTldrAsNote(
  attachment: Zotero.Item,
): Promise<"saved" | "none"> {
  const tldr = await getCachedTldr(attachment);
  if (!tldr) return "none";
  const parentID = attachment.parentItemID || attachment.id;
  const note = new Zotero.Item("note");
  note.libraryID = attachment.libraryID;
  note.parentID = parentID;
  const title = String(attachment.getField("title") || "").trim();
  const escaped = tldr
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  note.setNote(
    `<h2>SkimRead TL;DR</h2>${
      title ? `<p><em>${title}</em></p>` : ""
    }<p>${escaped}</p>`,
  );
  await note.saveTx();
  return "saved";
}

// ---------- public API ----------

export function isRunning(tabID: string): boolean {
  return !!jobs.get(tabID)?.running;
}

/**
 * Stop an in-flight run but KEEP whatever has already been painted. Long books
 * are the whole point of stopping early, so the partial highlights (and the
 * partial cache behind them) must survive; Generate later resumes from there.
 */
export function cancelSkim(tabID: string): void {
  const job = jobs.get(tabID);
  if (job) job.cancelled = true;
}

/**
 * Abandon a run outright: stop it, remove its overlays, and discard the cached
 * progress so the document goes back to a clean, never-run state. This is the
 * counterpart to Pause — it throws the work away on purpose.
 * Never touches user annotations, the library, or the file.
 */
export async function discardSkim(
  tabID: string,
  attachment: Zotero.Item,
): Promise<void> {
  clearHighlights(tabID);
  try {
    await cacheDelete(await cacheKey(attachment));
  } catch {
    // nothing cached for this document
  }
}

/** Remove overlays for a tab immediately (never touches user annotations). */
export function clearHighlights(tabID: string): void {
  const job = jobs.get(tabID);
  if (job) {
    job.cancelled = true;
    job.overlay?.clear();
    job.overlay = null;
  }
}

export interface RunCallbacks {
  onStatus: (msg: string) => void;
  onDone: (count: number) => void;
  onError: (msg: string) => void;
  onCounts?: (counts: Record<string, number>) => void;
  onLabels?: (labels: LabelDef[]) => void;
  onTldr?: (tldr: string) => void;
  /** EPUB: the selected highlights to render as a clickable list. */
  onHighlights?: (specs: HighlightSpec[]) => void;
}

/**
 * Generate (or regenerate) skim highlights for the reader in `tabID`.
 * `regenerate` deletes the cache entry first.
 */
export async function runSkim(
  reader: any,
  tabID: string,
  attachment: Zotero.Item,
  cb: RunCallbacks,
  regenerate = false,
): Promise<void> {
  clearHighlights(tabID);
  const job: JobState = {
    running: true,
    cancelled: false,
    overlay: null,
    pageCache: new Map(),
    itemID: attachment.id,
  };
  jobs.set(tabID, job);

  // `force` paints even after cancellation, so stopping a long run leaves the
  // work done so far on screen instead of wiping it.
  const paint = async (payload: CachePayload, force = false) => {
    if (!isReaderAlive(reader) || (job.cancelled && !force)) return 0;
    const density = Number(getPref("highlightDensity")) || 3;
    const specs = selectTopPerPage(payload.sentences, payload.labels, density);
    cb.onCounts?.(countByLabel(payload.sentences));
    const opacity = Number(getPref("highlightOpacity")) || 25;
    // EPUB: reflowable, lazily-rendered HTML — paint with the CSS Custom
    // Highlight API (non-destructive, no DOM nodes) and also surface the picks
    // as a clickable list in the sidebar for navigation.
    const showFlags = getPref("showFlags") !== false;
    if (isEpub(reader)) {
      cb.onHighlights?.(specs);
      job.overlay?.clear();
      job.overlay = await installEpubOverlays(
        reader,
        specs,
        opacity,
        showFlags,
      );
      return specs.length;
    }
    job.overlay?.clear();
    job.overlay = await installOverlays(
      reader,
      specs,
      opacity,
      job.pageCache,
      showFlags,
    );
    return specs.length;
  };

  try {
    const key = await cacheKey(attachment);
    if (regenerate) await cacheDelete(key);

    let payload = await cacheRead(key);
    if (payload?.complete) {
      cb.onLabels?.(payload.labels);
      cb.onDone(await paint(payload));
      return;
    }

    // Count tokens spent from here on; added to the cached totals at the end.
    resetTokenUsage();

    // A run must be resumable from the moment it starts, so pausing at ANY
    // point leaves a record for Resume to pick up. `resuming` is captured here
    // because the payload below is created eagerly rather than after labels.
    const resuming = !!payload;
    if (!payload) {
      payload = {
        promptVersion: PROMPT_VERSION,
        model: modelForProvider(String(getPref("skimModel"))),
        labels: [],
        sentences: [],
        complete: false,
        classifiedCount: 0,
      };
    }

    /**
     * Pause during extraction / label discovery, i.e. before this run has
     * selected anything. Returning silently here used to leave the sidebar
     * stuck on "Pausing…" with no Resume — most visible on PDFs, which spend
     * real time extracting page by page. Persist progress (including any
     * completed extraction), repaint earlier highlights, and always report.
     */
    const pausedBeforeSelection = async () => {
      const usage = getTokenUsage();
      payload!.tokensInput = (payload!.tokensInput || 0) + usage.input;
      payload!.tokensOutput = (payload!.tokensOutput || 0) + usage.output;
      await cacheWrite(key, payload!);
      const kept = payload!.sentences.length ? await paint(payload!, true) : 0;
      cb.onError(
        kept
          ? `Paused — ${kept} highlights kept, Resume to continue`
          : "Paused — Resume to continue",
      );
    };

    // ---- extract (needed both for fresh runs and to resume partial ones) ----
    const pages: PageText[] = [];
    let sentences: ExtractedSentence[] = [];
    // First page of the statistically detected reference zone (-1 = none).
    let referenceStartPage = -1;
    if (payload.extractComplete && payload.extracted?.length) {
      // Already read this document in an earlier (paused) run — skip straight
      // to selection. Page geometry is re-read lazily by the overlay painter.
      sentences = payload.extracted;
      cb.onStatus(`Resuming — ${sentences.length} sentences already read`);
    } else if (isEpub(reader)) {
      cb.onStatus("Reading EPUB…");
      const sections = await extractEpubSections(attachment);
      for (const s of sections) {
        if (job.cancelled) return await pausedBeforeSelection();
        const page = sectionAsPage(s.index, s.text);
        pages.push(page);
        job.pageCache.set(s.index, page);
        for (const sent of segmentSentences(page)) {
          sentences.push({ pageIndex: s.index, section: "body", ...sent });
        }
      }
    } else {
      cb.onStatus("Extracting text…");
      const pageCount = getPageCount(reader);
      for (let p = 0; p < pageCount; p++) {
        if (job.cancelled) return await pausedBeforeSelection();
        const page = await extractPage(reader, p);
        if (!page) continue;
        pages.push(page);
        job.pageCache.set(p, page);
      }
      // Zoning needs the whole document (furniture is defined by cross-page
      // repetition), so it runs between extraction and segmentation.
      const zones = analyzeZones(pages);
      if (zones.furnitureLineCount || zones.referenceStartPage >= 0) {
        const parts: string[] = [];
        if (zones.furnitureLineCount) {
          parts.push(
            `${zones.furnitureLineCount} repeated header/footer lines`,
          );
        }
        if (zones.referenceStartPage >= 0) {
          parts.push(`references from page ${zones.referenceStartPage + 1}`);
        }
        cb.onStatus(`Zoning: ${parts.join(", ")}`);
      }
      for (const page of pages) {
        for (const sent of segmentSentences(page)) {
          if (
            overlapsFurniture(
              zones,
              page.pageIndex,
              sent.startChar,
              sent.endChar,
            )
          ) {
            continue; // running header/footer, not content
          }
          sentences.push({
            pageIndex: page.pageIndex,
            section: "body",
            ...sent,
          });
        }
      }
      referenceStartPage = zones.referenceStartPage;
    }
    if (!sentences.length) {
      cb.onError(
        isEpub(reader)
          ? "No extractable text in this EPUB"
          : "No extractable text (scanned PDF?)",
      );
      return;
    }
    // EPUBs already have chapter sections; PDFs infer sections from headings.
    // Skipped when the sentences came back from cache already processed.
    if (!payload.extractComplete) {
      if (!isEpub(reader)) {
        sentences = withDocumentSections(pages, sentences);
        // Zone override AFTER heading inference, so it cannot be overwritten:
        // the statistically detected bibliography is references whether or not
        // any heading (in any language) was recognised.
        if (referenceStartPage >= 0) {
          for (const s of sentences) {
            if (
              s.pageIndex > referenceStartPage ||
              (s.pageIndex === referenceStartPage &&
                refSignalScore(s.text) >= 1)
            ) {
              s.section = "references";
            }
          }
        }
        sentences = limitWork(sentences);
      }
      // Persist immediately: reading the document is the slow, token-free part,
      // and no later pause should ever make the user pay for it twice.
      payload.extracted = sentences;
      payload.extractComplete = true;
      await cacheWrite(key, payload);
    }

    // ---- labels ----
    // Auto mode routes by document shape. A book/EPUB — or any book-like Zotero
    // Item Type — spans shifting topics, so labels evolve chapter by chapter
    // (adaptive). A focused paper is well served by one upfront discovery pass,
    // which held up better on papers. Page count is a fallback for untyped or
    // standalone attachments with no informative parent item.
    const isAuto = getLabelMode() === "auto";
    // When extraction was reused from cache there is no live `pages` array, so
    // fall back to what the cached sentences imply.
    const docPageCount =
      pages.length ||
      sentences.reduce((max, s) => Math.max(max, s.pageIndex), 0) + 1;
    const adaptiveAuto =
      isAuto &&
      (isEpub(reader) || isBookLikeItem(attachment) || docPageCount > 40);
    let labels: LabelDef[];
    if (resuming && payload.labels.length) {
      labels = payload.labels; // resuming: keep the labels of the partial run
    } else if (adaptiveAuto) {
      labels = []; // grows per chapter during selection
    } else if (isAuto) {
      const labelPages = pages.length ? pages : sentencesAsPages(sentences);
      labels =
        (await discoverLabels(labelPages, cb.onStatus)) ?? DEFAULT_LABELS;
    } else {
      labels = getConfiguredLabels() ?? DEFAULT_LABELS;
    }
    payload.labels = labels;
    if (job.cancelled) return await pausedBeforeSelection();
    if (!adaptiveAuto) cb.onLabels?.(labels);

    // ---- document selection ----
    // Focused papers use one complete-document selection whenever they fit the
    // configured context. Long documents are split at section/page boundaries;
    // book-like documents keep adaptive bands so their labels can evolve with
    // each chapter's distinct objective.
    const budget = payload.chunkBudget ?? selectionBudget();
    payload.chunkBudget = budget;
    const isCancelled = () => job.cancelled || !isReaderAlive(reader);

    const pageSpan =
      sentences.reduce((max, s) => Math.max(max, s.pageIndex), 0) + 1;
    payload.pageSpan = pageSpan;
    // Adaptive auto must run per band so labels can evolve section by section.
    const useBands = adaptiveAuto;
    let units: ExtractedSentence[][];
    let perUnitTarget = 0;
    if (useBands) {
      // ~1 band per 1.8 pages, but never so many that a band has too few
      // sentences to choose from (≥ ~6 candidates each).
      const bandCount = Math.max(
        3,
        Math.min(
          12,
          Math.round(pageSpan / 1.8),
          Math.floor(sentences.length / 6) || 3,
        ),
      );
      units = splitIntoBands(sentences, bandCount, budget);
      const targetTotal = Math.min(
        pageSpan * 3,
        Math.max(6, Math.round(pageSpan * 1.5)),
      );
      perUnitTarget = Math.max(1, Math.round(targetTotal / units.length));
    } else {
      units = chunkSentences(sentences, budget);
    }

    // Resume: skip units whose sentences were already consumed. Splitting is
    // deterministic for the same extraction, settings, and prompt version.
    let consumed = 0;
    let startUnit = 0;
    while (
      startUnit < units.length &&
      consumed + units[startUnit].length <= payload.classifiedCount
    ) {
      consumed += units[startUnit].length;
      startUnit++;
    }

    for (let index = startUnit; index < units.length; index++) {
      if (isCancelled()) break;
      const unit = units[index];
      cb.onStatus(
        units.length === 1
          ? `Selecting from all ${sentences.length} sentences…`
          : `Selecting highlights — part ${index + 1} of ${units.length}…`,
      );
      const selected = adaptiveAuto
        ? await selectBandAdaptive(labels, unit, perUnitTarget, isCancelled)
        : useBands
          ? await selectBand(labels, unit, perUnitTarget, isCancelled)
          : await selectDocument(labels, unit, isCancelled);
      if (isCancelled()) break;
      if (adaptiveAuto) {
        payload.labels = labels; // labels grew this band
        cb.onLabels?.(labels);
      }
      payload.sentences.push(...selected);
      consumed += unit.length;
      payload.classifiedCount = consumed;
      await cacheWrite(key, payload);
      await paint(payload); // progressive: bands appear as they finish
    }

    // ---- reduce ----
    // One pass over all candidates, seeing the document whole for the first
    // time. Skipped when resuming a run that already did it.
    if (!isCancelled() && !payload.reduced && payload.sentences.length >= 6) {
      cb.onStatus("Choosing the sentences that narrate the document…");
      const ok = await reducePass(payload.sentences, pageSpan, isCancelled);
      if (!isCancelled()) {
        payload.reduced = true;
        payload.coreCount = ok
          ? payload.sentences.filter((s) => s.core).length
          : 0;
        await cacheWrite(key, payload);
        await paint(payload);
      }
    }

    const finalizeTokens = () => {
      const usage = getTokenUsage();
      payload!.tokensInput = (payload!.tokensInput || 0) + usage.input;
      payload!.tokensOutput = (payload!.tokensOutput || 0) + usage.output;
    };

    if (job.cancelled || !isReaderAlive(reader)) {
      finalizeTokens();
      await cacheWrite(key, payload);
      // Keep the partial highlights on screen — stopping should not erase work.
      const kept = await paint(payload, true);
      cb.onError(
        kept
          ? `Paused — ${kept} highlights kept, Resume to continue`
          : "Paused — progress saved, Resume to continue",
      );
      return;
    }
    payload.complete = true;
    finalizeTokens();
    await cacheWrite(key, payload);
    cb.onDone(await paint(payload));

    // Optional: produce the TL;DR in the same run, with the same (skim) model,
    // reusing the text already extracted above — no second model load.
    if (getPref("tldrWithSkim") && !payload.tldr && !isCancelled()) {
      resetTokenUsage(); // count TL;DR tokens separately, then fold them in
      try {
        cb.onStatus("Summarizing (TL;DR)…");
        const title = String(attachment.getField("title") || "").trim();
        const text = await leadingText(reader, attachment, job.pageCache);
        if (text) {
          const tldr = await summarizeText(
            title,
            text,
            modelForProvider(String(getPref("skimModel"))),
          );
          payload.tldr = tldr;
          finalizeTokens();
          await cacheWrite(key, payload);
          cb.onTldr?.(tldr);
        }
      } catch (tldrError) {
        // A TL;DR failure must never fail the highlight run.
        ztoolkit.log("skimread inline tldr error", tldrError);
      }
    }
  } catch (e) {
    ztoolkit.log("skimread skim error", e);
    cb.onError(String((e as Error)?.message || e).slice(0, 140));
  } finally {
    job.running = false;
  }
}
