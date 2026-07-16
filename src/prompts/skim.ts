/**
 * Versioned prompts for skim classification with dynamic label sets.
 * Bump PROMPT_VERSION whenever any prompt text changes (invalidates cache).
 */
export const PROMPT_VERSION = 4;

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
): string {
  return [
    "Choose the sentences worth highlighting while skimming this entire document.",
    `Return at most ${maxPerPage} selected sentences per page.`,
    "Use the numeric id exactly as supplied. Do not return a sentence more than once.",
    "Use each sentence's section to judge its role in the paper, not merely its wording.",
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
  const selected = (raw as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) return null;
  const allowed = new Set(labels.map((label) => label.key));
  const seen = new Set<number>();
  const out: DocumentSelection[] = [];
  for (const entry of selected) {
    const value = entry as {
      id?: unknown;
      label?: unknown;
      importance?: unknown;
    };
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.id !== "number" ||
      !Number.isInteger(value.id) ||
      value.id < 0 ||
      value.id >= sentenceCount ||
      seen.has(value.id) ||
      typeof value.label !== "string" ||
      !allowed.has(value.label) ||
      typeof value.importance !== "number"
    ) {
      return null;
    }
    seen.add(value.id);
    out.push({
      id: value.id,
      label: value.label,
      importance: Math.max(0, Math.min(1, value.importance)),
    });
  }
  return out;
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
