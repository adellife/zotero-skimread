/**
 * Explicit conversion of SkimRead overlays to normal Zotero highlights.
 * Nothing is written until the reader presses the dedicated save button.
 */
import {
  annotationPositionForRange,
  epubAnnotationsFromSpecs,
  HighlightSpec,
  PageText,
} from "../reader/adapter";
import { cleanAnnotationText } from "../utils/text";
import { getPref } from "../utils/prefs";

export { cleanAnnotationText } from "../utils/text";

function colorToHex(colorRGB: string): string {
  const parts = colorRGB.split(",").map((value) => Number(value.trim()));
  if (
    parts.length !== 3 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return "#ffd400";
  }
  return `#${parts.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Tag carrying the rhetorical label. Colour alone is lossy: it is easy to
 * change, indistinguishable once several labels share a palette, and invisible
 * to search. A tag keeps the category attached to the annotation, and makes the
 * set filterable in Zotero and groupable in "Add Note from Annotations".
 */
type AnnotationTags = _ZoteroTypes.Annotations.AnnotationJson["tags"];
export type AnnotationLabelDestination = "comment" | "tag" | "none";

function labelTags(label: string): AnnotationTags {
  const name = String(label || "").trim();
  // saveFromJSON does `setTags((json.tags || []).map(t => ({tag: t.name})))`,
  // so the runtime wants an array of {name} — verified against Zotero 9.0.6
  // source. The bundled typings describe a single {name,color} object instead,
  // so cast at this one boundary rather than weaken the call sites.
  return (name ? [{ name }] : []) as unknown as AnnotationTags;
}

function currentLabelDestination(): AnnotationLabelDestination {
  const value = String(getPref("annotationLabelDestination") || "comment");
  return value === "tag" || value === "none" ? value : "comment";
}

/** Zotero fields used to carry a rhetorical label into a saved annotation. */
export function annotationLabelFields(
  label: string,
  destination: AnnotationLabelDestination,
  includePluginName = false,
): { comment: string; tags: AnnotationTags } {
  const name = String(label || "").trim();
  if (!name || destination === "none") {
    return { comment: "", tags: [] as unknown as AnnotationTags };
  }
  if (destination === "tag") {
    return { comment: "", tags: labelTags(name) };
  }
  return {
    comment: includePluginName ? `SkimRead: ${name}` : name,
    tags: [] as unknown as AnnotationTags,
  };
}

function annotationKey(): string {
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  const random = crypto.getRandomValues(new Uint8Array(8));
  return [...random].map((value) => alphabet[value % alphabet.length]).join("");
}

function sortIndex(pageIndex: number, startChar: number): string {
  return [
    String(pageIndex).slice(0, 5).padStart(5, "0"),
    String(startChar).slice(0, 6).padStart(6, "0"),
    "00000",
  ].join("|");
}

function annotationJSON(
  attachment: Zotero.Item,
  spec: HighlightSpec,
  page: PageText,
): _ZoteroTypes.Annotations.AnnotationJson | null {
  if (!attachment.libraryID) {
    throw new Error(
      "The PDF attachment must be saved in a Zotero library first",
    );
  }
  const position = annotationPositionForRange(
    page,
    spec.startChar,
    spec.endChar,
  );
  if (!position) return null;
  const key = annotationKey();
  const labelFields = annotationLabelFields(
    spec.label,
    currentLabelDestination(),
    getPref("annotationCommentPrefix") === true,
  );
  return {
    id: key,
    key,
    libraryID: attachment.libraryID,
    type: "highlight",
    text: cleanAnnotationText(spec.text),
    isExternal: false,
    readOnly: false,
    comment: labelFields.comment,
    color: colorToHex(spec.colorRGB),
    pageLabel: String(spec.pageIndex + 1),
    sortIndex: sortIndex(spec.pageIndex, spec.startChar),
    position,
    tags: labelFields.tags,
    dateModified: "",
  };
}

/**
 * EPUB equivalent of saveNativeHighlights. Positions are EPUB CFIs rather than
 * page rects, produced by the reader view from the same DOM ranges the overlay
 * painter uses. Only sentences in rendered sections can be converted; the count
 * that could not be is returned so the UI can say so plainly.
 */
export async function saveEpubHighlights(
  attachment: Zotero.Item,
  reader: any,
  specs: HighlightSpec[],
): Promise<{ saved: string[]; skipped: number }> {
  if (!attachment.libraryID) {
    throw new Error(
      "The EPUB attachment must be saved in a Zotero library first",
    );
  }
  const { annotations, skipped } = epubAnnotationsFromSpecs(reader, specs);
  const saved: string[] = [];
  for (const ann of annotations) {
    const key = annotationKey();
    const labelFields = annotationLabelFields(
      ann.skimreadLabel,
      currentLabelDestination(),
      getPref("annotationCommentPrefix") === true,
    );
    const json = {
      ...ann,
      id: key,
      key,
      libraryID: attachment.libraryID,
      isExternal: false,
      readOnly: false,
      comment: labelFields.comment,
      ...(typeof ann.text === "string"
        ? { text: cleanAnnotationText(ann.text) }
        : {}),
      pageLabel: String(ann.pageLabel ?? ""),
      tags: labelFields.tags,
      dateModified: "",
    } as _ZoteroTypes.Annotations.AnnotationJson;
    const item = await Zotero.Annotations.saveFromJSON(attachment, json);
    saved.push(item.key);
  }
  return { saved, skipped };
}

export async function saveNativeHighlights(
  attachment: Zotero.Item,
  specs: HighlightSpec[],
  pages: Map<number, PageText>,
): Promise<string[]> {
  const saved: string[] = [];
  for (const spec of specs) {
    const page = pages.get(spec.pageIndex);
    if (!page) continue;
    const annotation = annotationJSON(attachment, spec, page);
    if (!annotation) continue;
    const item = await Zotero.Annotations.saveFromJSON(attachment, annotation);
    saved.push(item.key);
  }
  return saved;
}
