/**
 * EPUB text extraction. Reads the .epub (a ZIP), follows the OPF spine to get
 * chapters in reading order, and returns each chapter's plain text. Position
 * mapping (CFI/overlays) is out of scope here — SkimRead uses the chapter text
 * for selection and locates highlights in the reader by text search.
 */
import JSZip from "jszip";

// JSZip's async engine expects setImmediate, which Zotero's runtime lacks.
// Shim it with a microtask so JSZip can defer work.
const g = globalThis as unknown as {
  setImmediate?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => number;
  clearImmediate?: (id: number) => void;
};
if (typeof g.setImmediate !== "function") {
  g.setImmediate = (fn, ...args) => {
    void Promise.resolve().then(() => fn(...args));
    return 0;
  };
  g.clearImmediate = () => {};
}

export interface EpubSection {
  index: number;
  title: string;
  text: string;
}

function stripHtml(html: string): string {
  // Drop script/style, turn block boundaries into spaces, remove tags, decode
  // the handful of entities that matter, and collapse whitespace.
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|section|article|blockquote)>/gi, "$&\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = withoutHead.replace(/<[^>]+>/g, " ");
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Resolve a path relative to a base file within the zip. */
function resolvePath(base: string, href: string): string {
  const stack = base.split("/").slice(0, -1);
  for (const part of href.split("/")) {
    if (part === "..") stack.pop();
    else if (part !== ".") stack.push(part);
  }
  return stack.join("/");
}

async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async("text");
  return new DOMParser().parseFromString(text, "application/xml");
}

/** Ordered content document paths from the OPF spine. */
async function spinePaths(zip: JSZip): Promise<string[]> {
  const container = await readXml(zip, "META-INF/container.xml");
  const opfPath = container
    ?.querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!opfPath) return [];
  const opf = await readXml(zip, opfPath);
  if (!opf) return [];
  const manifest = new Map<string, string>();
  const items = Array.from(
    opf.querySelectorAll("manifest > item"),
  ) as Element[];
  for (const item of items) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolvePath(opfPath, href));
  }
  const paths: string[] = [];
  const refs = Array.from(opf.querySelectorAll("spine > itemref")) as Element[];
  for (const ref of refs) {
    const idref = ref.getAttribute("idref");
    const path = idref ? manifest.get(idref) : undefined;
    if (path) paths.push(path);
  }
  return paths;
}

export async function extractEpubSections(
  attachment: Zotero.Item,
): Promise<EpubSection[]> {
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("EPUB file is unavailable");
  // IOUtils.read returns a Uint8Array from Zotero's privileged compartment.
  // JSZip does `instanceof Uint8Array` against its own realm, so copy the
  // bytes into a fresh array created here before loading.
  const raw = await IOUtils.read(path);
  const bytes = new Uint8Array(raw.length);
  bytes.set(raw);
  const zip = await JSZip.loadAsync(bytes.buffer);

  let paths = await spinePaths(zip);
  if (!paths.length) {
    // Fallback: any XHTML/HTML in the archive, in a stable order.
    paths = Object.keys(zip.files)
      .filter((name) => /\.x?html?$/i.test(name))
      .sort();
  }

  const sections: EpubSection[] = [];
  for (const p of paths) {
    const file = zip.file(p);
    if (!file) continue;
    const html = await file.async("text");
    const text = stripHtml(html);
    if (text.length < 40) continue; // skip covers, nav, empty pages
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].trim()
      : p.split("/").pop() || `Section ${sections.length + 1}`;
    sections.push({ index: sections.length, title, text });
  }
  return sections;
}
