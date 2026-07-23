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
  modelForProvider,
  providerLabel,
} from "../llm/ollama";
import {
  PROMPT_VERSION,
  LabelDef,
  DEFAULT_LABELS,
  DISCOVER_SCHEMA,
  DISCOVER_SYSTEM,
  buildDocumentSelectionPrompt,
  buildDocumentSelectionSchema,
  buildSkimSystem,
  buildTldrPrompt,
  parseCustomLabels,
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
  isReaderAlive,
  HighlightSpec,
  OverlayController,
  PageText,
} from "../reader/adapter";
import { saveNativeHighlights } from "./annotations";

export interface ClassifiedSentence {
  pageIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  label: string;
  confidence: number;
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
const MAX_LEN = 600;
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
}

/** Persistent run summary for the sidebar's idle status line. */
export async function cacheSummary(
  attachment: Zotero.Item,
): Promise<CacheSummary> {
  const payload = await cacheRead(await cacheKey(attachment));
  if (!payload) return { state: "none", selections: 0, considered: 0 };
  const selections = payload.sentences.filter(
    (sentence) => sentence.label !== "none" && sentence.confidence >= 0.5,
  ).length;
  return {
    state: payload.complete ? "complete" : "partial",
    selections,
    considered: payload.classifiedCount,
  };
}

export async function getCachedLabels(
  attachment: Zotero.Item,
): Promise<LabelDef[] | null> {
  return (await cacheRead(await cacheKey(attachment)))?.labels ?? null;
}

/** Whether this exact cached skim run has already been saved to Zotero. */
export async function hasSavedAnnotations(
  attachment: Zotero.Item,
): Promise<boolean> {
  const payload = await cacheRead(await cacheKey(attachment));
  return !!payload?.savedAnnotationKeys?.length;
}

// ---------- segmentation ----------

function segmentSentences(
  page: PageText,
): Omit<ExtractedSentence, "pageIndex" | "section">[] {
  const out: Omit<ExtractedSentence, "pageIndex" | "section">[] = [];
  if (!page.text) return out;
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const s of seg.segment(page.text)) {
    const text = s.segment.trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    if (!/[a-zA-Z]{3}/.test(text)) continue;
    const startText =
      s.index + (s.segment.length - s.segment.trimStart().length);
    const endText = startText + text.length;
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
  return out;
}

const SECTION_MARKERS: [RegExp, DocumentSection][] = [
  [
    /\b(?:references|bibliography|works cited|literature cited|cited literature|reference list)\b/i,
    "references",
  ],
  [/\b(?:appendix|supplementary materials?)\b/i, "appendix"],
  [/\b(?:abstract|summary)\b/i, "abstract"],
  [/\b(?:introduction|background)\b/i, "introduction"],
  [
    /\b(?:materials? and methods?|methods?|methodology|experimental setup)\b/i,
    "methods",
  ],
  [/\b(?:results?|findings?)\b/i, "results"],
  [/\b(?:discussion|analysis)\b/i, "discussion"],
  [/\b(?:conclusions?|concluding remarks?)\b/i, "conclusion"],
];

/**
 * Infer a coarse document role from headings near the top of each page. The
 * role is sent to the whole-document selector as structural context; it is
 * deliberately not treated as a replacement for the model's judgement.
 */
function sectionAtPageStart(page: PageText): DocumentSection | null {
  const lead = page.text.slice(0, 900);
  for (const [marker, section] of SECTION_MARKERS) {
    if (marker.test(lead)) return section;
  }
  return null;
}

/** Attach the active paper section to each sentence, carrying headings forward. */
function withDocumentSections(
  pages: PageText[],
  sentences: ExtractedSentence[],
): typeof sentences {
  const sections = new Map<number, DocumentSection>();
  let active: DocumentSection = "front matter";
  let anyDetected = false;
  for (const p of pages) {
    const detected = sectionAtPageStart(p);
    if (detected) {
      active = detected;
      anyDetected = true;
    }
    sections.set(p.pageIndex, active);
  }
  // Documents without recognizable headings (many books, slides, reports)
  // must not end up wholly labeled "front matter": treat them as body text.
  if (!anyDetected) {
    for (const p of pages) sections.set(p.pageIndex, "body");
  }
  return sentences.map((sentence) => ({
    ...sentence,
    section: sections.get(sentence.pageIndex) || "body",
  }));
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
    list.sort((a, b) => b.confidence - a.confidence);
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
): Promise<{ saved: number; alreadySaved: boolean }> {
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
  cachedPages?: Map<number, PageText>,
): Promise<string> {
  return (async () => {
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
  const text = await leadingText(reader);
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

  const paint = async (payload: CachePayload) => {
    if (!isReaderAlive(reader) || job.cancelled) return 0;
    const density = Number(getPref("highlightDensity")) || 3;
    const opacity = Number(getPref("highlightOpacity")) || 25;
    const showFlags = getPref("showFlags") !== false;
    const specs = selectTopPerPage(payload.sentences, payload.labels, density);
    job.overlay?.clear();
    job.overlay = await installOverlays(
      reader,
      specs,
      opacity,
      job.pageCache,
      showFlags,
    );
    cb.onCounts?.(countByLabel(payload.sentences));
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

    // ---- extract (needed both for fresh runs and to resume partial ones) ----
    cb.onStatus("Extracting text…");
    const pageCount = getPageCount(reader);
    const pages: PageText[] = [];
    let sentences: ExtractedSentence[] = [];
    for (let p = 0; p < pageCount; p++) {
      if (job.cancelled) return;
      const page = await extractPage(reader, p);
      if (!page) continue;
      pages.push(page);
      job.pageCache.set(p, page);
      for (const sent of segmentSentences(page)) {
        sentences.push({ pageIndex: p, section: "body", ...sent });
      }
    }
    if (!sentences.length) {
      cb.onError("No extractable text (scanned PDF?)");
      return;
    }
    sentences = limitWork(withDocumentSections(pages, sentences));

    // ---- labels ----
    let labels: LabelDef[];
    if (payload) {
      labels = payload.labels; // resuming: keep the labels of the partial run
    } else {
      let configured = getConfiguredLabels();
      if (!configured) {
        configured = await discoverLabels(pages, cb.onStatus);
        if (!configured) {
          cb.onError("Label discovery failed — using defaults");
          configured = DEFAULT_LABELS;
        }
      }
      labels = configured;
      payload = {
        promptVersion: PROMPT_VERSION,
        model: modelForProvider(String(getPref("skimModel"))),
        labels,
        sentences: [],
        complete: false,
        classifiedCount: 0,
      };
    }
    if (job.cancelled) return;
    cb.onLabels?.(labels);

    // ---- document selection (single chunk for papers; chapter/context-sized
    // chunks for books and small-context providers) ----
    const budget = payload.chunkBudget ?? selectionBudget();
    payload.chunkBudget = budget;
    const chunks = chunkSentences(sentences, budget);
    const isCancelled = () => job.cancelled || !isReaderAlive(reader);

    // Resume: skip chunks whose sentences were already consumed. Chunking is
    // deterministic for the same extraction, settings, and prompt version.
    let consumed = 0;
    let startChunk = 0;
    while (
      startChunk < chunks.length &&
      consumed + chunks[startChunk].length <= payload.classifiedCount
    ) {
      consumed += chunks[startChunk].length;
      startChunk++;
    }

    for (let index = startChunk; index < chunks.length; index++) {
      if (isCancelled()) break;
      const chunk = chunks[index];
      cb.onStatus(
        chunks.length === 1
          ? `Selecting from all ${sentences.length} sentences…`
          : `Selecting highlights — part ${index + 1} of ${chunks.length} (${chunk.length} sentences)…`,
      );
      const selected = await selectDocument(labels, chunk, isCancelled);
      if (isCancelled()) break;
      payload.sentences.push(...selected);
      consumed += chunk.length;
      payload.classifiedCount = consumed;
      await cacheWrite(key, payload);
      await paint(payload); // progressive: chapters appear as they finish
    }

    if (job.cancelled || !isReaderAlive(reader)) {
      cb.onError("Stopped — progress saved, Generate resumes");
      return;
    }
    payload.complete = true;
    await cacheWrite(key, payload);
    cb.onDone(await paint(payload));

    // Optional: produce the TL;DR in the same run, with the same (skim) model,
    // reusing the text already extracted above — no second model load.
    if (getPref("tldrWithSkim") && !payload.tldr && !isCancelled()) {
      try {
        cb.onStatus("Summarizing (TL;DR)…");
        const title = String(attachment.getField("title") || "").trim();
        const text = await leadingText(reader, job.pageCache);
        if (text) {
          const tldr = await summarizeText(
            title,
            text,
            modelForProvider(String(getPref("skimModel"))),
          );
          payload.tldr = tldr;
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
