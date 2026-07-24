/**
 * Versioned prompts for skim classification with dynamic label sets.
 * Bump PROMPT_VERSION whenever any prompt text changes (invalidates cache).
 */
export const PROMPT_VERSION = 13;

export interface LabelDef {
  key: string; // stable slug, e.g. "theory"
  name: string; // shown on flags/sidebar, e.g. "Theory"
  color: string; // "r, g, b"
  description: string; // used in the classification prompt
}

/** Semantic Reader palette + extras, assigned to labels in order. */
export const PALETTE = [
  "0, 177, 253", // SR blue
  "254, 97, 0", // SR orange
  "220, 38, 127", // SR pink
  "142, 68, 173", // purple
  "30, 158, 80", // green
  "184, 134, 11", // dark goldenrod
  "0, 139, 139", // teal
  "205, 92, 92", // indian red
];

export const DEFAULT_LABELS: LabelDef[] = [
  {
    key: "goal",
    name: "Goal",
    color: PALETTE[0],
    description:
      "states the research objective, problem, or question the work addresses",
  },
  {
    key: "method",
    name: "Method",
    color: PALETTE[1],
    description:
      "describes how the work was done: approach, data, procedure, experimental setup",
  },
  {
    key: "result",
    name: "Result",
    color: PALETTE[2],
    description: "reports a finding, measurement, or outcome",
  },
  {
    key: "novelty",
    name: "Novelty",
    color: PALETTE[3],
    description: "claims what is new or different from prior work",
  },
];

export function buildSkimSystem(labels: LabelDef[]): string {
  const lines = labels.map((l) => `- ${l.key}: ${l.description}.`).join("\n");
  return `You select the most useful sentences from a scholarly document (paper, book chapter, or report) to support skimming.
Labels:
${lines}
- Do not select background filler, citation lists, boilerplate, figure captions, appendices, or references.
Rules: consider the complete document jointly. Judge importance by each sentence's role in the paper and its contribution to the paper's central claim, not by word frequency or isolated wording. The supplied section field is structural evidence: prioritize the abstract, introduction, methods, results, discussion, and conclusion; never select references. Prefer a diverse, non-redundant set that lets a reader recover the paper's argument, approach, findings, and novelty. Select only supplied sentence IDs; never rewrite text. Importance is 0-1. Return JSON only.`;
}

export function buildSkimUserPrompt(
  sentences: { id: number; text: string }[],
): string {
  return (
    "Classify each numbered sentence. Return JSON only.\n\n" +
    sentences.map((s) => `${s.id}. ${s.text}`).join("\n")
  );
}

/** Input for one full-document selection pass. */
export function buildDocumentSelectionPrompt(
  sentences: {
    id: number;
    pageIndex: number;
    section: string;
    text: string;
  }[],
  maxPerPage: number,
  labels: LabelDef[] = DEFAULT_LABELS,
): string {
  const pageCount = new Set(sentences.map((sentence) => sentence.pageIndex))
    .size;
  const minTotal = Math.max(6, pageCount);
  const maxTotal = pageCount * 3;
  const keys = labels.map((label) => label.key).join(" | ");
  return [
    "Choose the sentences worth highlighting while skimming this entire document.",
    `Select between ${minTotal} and ${maxTotal} sentences in total for these ${pageCount} pages — aim for roughly 2 per page.`,
    "Spread selections across the WHOLE document — early, middle, and late pages. Do not concentrate them in the conclusion or on any single page.",
    "Cover every major section; do not leave long stretches of the document without a highlight.",
    `Return at most ${maxPerPage} selected sentences per page.`,
    "Use the numeric id exactly as supplied. Do not return a sentence more than once.",
    "Use each sentence's section to judge its role in the paper, not merely its wording.",
    "",
    "Return ONLY this JSON, no prose or code fences:",
    `{"selected":[{"id":<integer>,"label":"<one of: ${keys}>","importance":<0..1>}]}`,
    "",
    ...sentences.map(
      (sentence) =>
        `${sentence.id} | page ${sentence.pageIndex + 1} | section ${sentence.section} | ${sentence.text}`,
    ),
  ].join("\n");
}

export function buildSkimSchema(labels: LabelDef[]) {
  return {
    type: "object",
    properties: {
      sentences: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            label: {
              type: "string",
              enum: [...labels.map((l) => l.key), "none"],
            },
            confidence: { type: "number" },
          },
          required: ["id", "label", "confidence"],
        },
      },
    },
    required: ["sentences"],
  };
}

/** Schema for global selection: unselected sentences are intentionally omitted. */
/**
 * Prompt for one passage (band/section) in hierarchical map-reduce selection.
 * Asking for a fixed small count per passage guarantees the whole document is
 * covered instead of the model concentrating on one region.
 */
export function buildBandSelectionPrompt(
  sentences: {
    id: number;
    pageIndex: number;
    section: string;
    text: string;
  }[],
  targetCount: number,
  labels: LabelDef[] = DEFAULT_LABELS,
): string {
  const keys = labels.map((label) => label.key).join(" | ");
  return [
    `This is ONE passage from a larger document. Select the ${targetCount} most useful sentences here to highlight for skimming (at most ${targetCount + 1}).`,
    "Pick the most informative ones and spread them across the passage; do not cluster them together.",
    "Use the numeric id exactly as supplied. Do not return a sentence more than once.",
    "Return ONLY this JSON, no prose or code fences:",
    `{"selected":[{"id":<integer>,"label":"<one of: ${keys}>","importance":<0..1>}]}`,
    "",
    ...sentences.map(
      (sentence) =>
        `${sentence.id} | page ${sentence.pageIndex + 1} | section ${sentence.section} | ${sentence.text}`,
    ),
  ].join("\n");
}

// ---------- adaptive (evolving) label selection ----------

export const ADAPTIVE_SYSTEM = `You select and label the most useful sentences from a scholarly document to support skimming.
You maintain a small, consistent set of role labels (aim for 3-6, never more than 8). Reuse existing labels wherever possible; add a new short label only when a sentence's role genuinely fits none of them, and never invent near-duplicates of an existing label. Return JSON only.`;

export function buildAdaptiveSelectionPrompt(
  sentences: { id: number; text: string }[],
  targetCount: number,
  labels: LabelDef[],
): string {
  const existing = labels.length
    ? labels.map((l) => `- ${l.key}: ${l.description || l.name}`).join("\n")
    : "(none defined yet — you decide the first labels for this document)";
  return [
    `This is ONE passage from a larger document. Select the ${targetCount} most useful sentences to highlight for skimming (at most ${targetCount + 1}), spread across the passage.`,
    "Label each selected sentence with its role. Prefer these existing labels:",
    existing,
    "If a sentence truly fits none, create a short new lowercase label (one or two words). Reuse labels consistently across the document.",
    'Return ONLY this JSON, no prose: {"selected":[{"id":<integer>,"label":"<label>","importance":<0..1>}]}',
    "",
    ...sentences.map((s) => `${s.id} | ${s.text}`),
  ].join("\n");
}

export const ADAPTIVE_SCHEMA = {
  type: "object",
  properties: {
    selected: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          label: { type: "string" },
          importance: { type: "number" },
        },
        required: ["id", "label", "importance"],
        additionalProperties: false,
      },
    },
  },
  required: ["selected"],
  additionalProperties: false,
};

export interface AdaptiveResult {
  id: number;
  label: string;
  importance: number;
}

/** Validate adaptive output: any non-empty label is allowed (reconciled later). */
export function validateAdaptiveSelection(
  raw: unknown,
  sentenceCount: number,
): AdaptiveResult[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const arr = (raw as { selected?: unknown }).selected;
  if (!Array.isArray(arr)) return null;
  const seen = new Set<number>();
  const out: AdaptiveResult[] = [];
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return null;
  };
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const idN = toNum(e.id);
    if (idN === null) continue;
    const id = Math.trunc(idN);
    if (id < 0 || id >= sentenceCount || seen.has(id)) continue;
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) continue;
    seen.add(id);
    out.push({
      id,
      label,
      importance: Math.max(
        0,
        Math.min(1, toNum(e.importance) ?? toNum(e.confidence) ?? 0.7),
      ),
    });
  }
  return out.length ? out : null;
}

export function buildDocumentSelectionSchema(labels: LabelDef[]) {
  return {
    type: "object",
    properties: {
      selected: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            label: { type: "string", enum: labels.map((label) => label.key) },
            importance: { type: "number" },
          },
          required: ["id", "label", "importance"],
          additionalProperties: false,
        },
      },
    },
    required: ["selected"],
    additionalProperties: false,
  };
}

// ---------- TL;DR summary ----------

export const TLDR_SYSTEM = `You write a faithful TL;DR of a scholarly document for a researcher skimming it.
Rules:
- 2 to 4 sentences, plain and specific.
- State what the work does, how, and its main finding or contribution.
- Use only the provided text. Never invent numbers, datasets, or claims.
- No preamble ("This paper..."), no markdown, no citations. Return JSON only.`;

export function buildTldrPrompt(title: string, text: string): string {
  return [
    title ? `Title: ${title}` : "",
    "",
    "Document text (may be truncated):",
    text,
  ]
    .join("\n")
    .trim();
}

export const TLDR_SCHEMA = {
  type: "object",
  properties: { tldr: { type: "string" } },
  required: ["tldr"],
  additionalProperties: false,
};

/** Extract and lightly clean the TL;DR string. Returns null if unusable. */
export function validateTldr(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { tldr?: unknown }).tldr;
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length >= 20 ? text : null;
}

export interface SkimResult {
  id: number;
  label: string;
  confidence: number;
}

/** Validate LLM classification output. Returns null if invalid. */
export function validateSkimResponse(
  raw: unknown,
  labels: LabelDef[],
): SkimResult[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const arr = (raw as { sentences?: unknown }).sentences;
  if (!Array.isArray(arr)) return null;
  const valid = new Set([...labels.map((l) => l.key), "none"]);
  const out: SkimResult[] = [];
  for (const e of arr) {
    const o = e as { id?: unknown; label?: unknown; confidence?: unknown };
    if (
      typeof o !== "object" ||
      o === null ||
      typeof o.id !== "number" ||
      typeof o.label !== "string" ||
      !valid.has(o.label) ||
      typeof o.confidence !== "number"
    ) {
      return null;
    }
    out.push({
      id: o.id,
      label: o.label,
      confidence: Math.max(0, Math.min(1, o.confidence)),
    });
  }
  return out;
}

export interface DocumentSelection {
  id: number;
  label: string;
  importance: number;
}

/** Validate selected IDs against the complete source document. */
export function validateDocumentSelection(
  raw: unknown,
  labels: LabelDef[],
  sentenceCount: number,
): DocumentSelection[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as { selected?: unknown; sentences?: unknown };
  // Accept the documented `selected` key, or a bare array / `sentences` alias
  // some models emit instead.
  const selected = Array.isArray(root.selected)
    ? root.selected
    : Array.isArray(root.sentences)
      ? root.sentences
      : Array.isArray(raw)
        ? (raw as unknown[])
        : null;
  if (!selected) return null;

  // Match label keys case-insensitively, and also accept a label's display
  // name (e.g. "Goal" for key "goal").
  const byKey = new Map<string, string>();
  for (const label of labels) {
    byKey.set(label.key.toLowerCase(), label.key);
    byKey.set(label.name.toLowerCase(), label.key);
  }

  const toNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const seen = new Set<number>();
  const out: DocumentSelection[] = [];
  for (const entry of selected) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    const idNum = toNumber(value.id);
    if (idNum === null) continue;
    const id = Math.trunc(idNum);
    if (id < 0 || id >= sentenceCount || seen.has(id)) continue;
    const labelRaw =
      typeof value.label === "string"
        ? value.label
        : typeof value.category === "string"
          ? value.category
          : "";
    const label = byKey.get(labelRaw.trim().toLowerCase());
    if (!label) continue;
    // Accept importance / confidence / score / weight; default when absent.
    const imp =
      toNumber(value.importance) ??
      toNumber(value.confidence) ??
      toNumber(value.score) ??
      toNumber(value.weight) ??
      0.7;
    seen.add(id);
    out.push({ id, label, importance: Math.max(0, Math.min(1, imp)) });
  }
  // Only a completely unusable response fails (triggering the repair retry).
  return out.length ? out : null;
}

// ---------- zero-shot label discovery ----------

export const DISCOVER_SYSTEM = `You design a skimming aid for a scholarly document (research paper, book, book chapter, thesis, or report).
Given a sample of the document, propose 3 to 6 category labels that capture the kinds of sentences a reader should notice while skimming THIS document (e.g. for a theory-heavy paper: theoretical background, hypothesis, argument, evidence; for a methods paper: goal, method, result).
Rules:
- key: short lowercase slug (a-z only, max 12 chars), unique.
- name: 1-2 word display name.
- description: one clause describing which sentences match, usable in a classification prompt.
- Order labels by importance. Return JSON only.`;

export const DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["key", "name", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["labels"],
  additionalProperties: false,
};

/** Validate discovery output into LabelDefs with palette colors. */
export function validateDiscovery(raw: unknown): LabelDef[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const arr = (raw as { labels?: unknown }).labels;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const out: LabelDef[] = [];
  const seen = new Set<string>();
  for (const e of arr.slice(0, 6)) {
    const o = e as { key?: unknown; name?: unknown; description?: unknown };
    if (
      typeof o.key !== "string" ||
      typeof o.name !== "string" ||
      typeof o.description !== "string"
    ) {
      return null;
    }
    const key = o.key
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .slice(0, 12);
    if (!key || seen.has(key) || key === "none") continue;
    seen.add(key);
    out.push({
      key,
      name: o.name.slice(0, 24),
      color: PALETTE[out.length % PALETTE.length],
      description: o.description.slice(0, 200),
    });
  }
  return out.length >= 2 ? out : null;
}

/** Parse user-provided custom labels JSON. Returns null if invalid. */
export function parseCustomLabels(json: string): LabelDef[] | null {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || !arr.length) return null;
    const out: LabelDef[] = [];
    const seen = new Set<string>();
    for (const e of arr.slice(0, 8)) {
      if (typeof e?.key !== "string" || typeof e?.name !== "string") {
        return null;
      }
      const key = e.key
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 12);
      if (!key || seen.has(key) || key === "none") return null;
      seen.add(key);
      out.push({
        key,
        name: String(e.name).slice(0, 24),
        color:
          typeof e.color === "string" && /^\d+,\s*\d+,\s*\d+$/.test(e.color)
            ? e.color
            : PALETTE[out.length % PALETTE.length],
        description: String(e.description || e.name).slice(0, 200),
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
