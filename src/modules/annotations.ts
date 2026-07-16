/**
 * Explicit conversion of Local Reader overlays to normal Zotero highlights.
 * Nothing is written until the reader presses the dedicated save button.
 */
import {
  annotationPositionForRange,
  HighlightSpec,
  PageText,
} from "../reader/adapter";

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
  return {
    id: key,
    key,
    libraryID: attachment.libraryID,
    type: "highlight",
    text: spec.text,
    isExternal: false,
    readOnly: false,
    comment: "",
    color: colorToHex(spec.colorRGB),
    pageLabel: String(spec.pageIndex + 1),
    sortIndex: sortIndex(spec.pageIndex, spec.startChar),
    position,
    dateModified: "",
  };
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
