/**
 * Compare two skimming plugins on the same document.
 *
 * Run in Zotero: Tools -> Developer -> Run JavaScript, with the document open
 * in a reader tab. Both plugins must have written annotations to it first
 * (SkimRead: "Save as Zotero annotations…").
 *
 * Sets are told apart by tags: SkimRead tags every annotation it saves with its
 * rhetorical label; other plugins seen so far leave tags empty. Adjust
 * SKIMREAD_TAGS if you use custom labels.
 *
 * Reports what can be measured objectively (count, page coverage, distribution,
 * overlap). Judging which selection is *better* still needs a human, ideally
 * blind — see the note printed at the end.
 */

const SKIMREAD_TAGS = new Set([
  "Goal",
  "Method",
  "Result",
  "Novelty",
  "Conclusion",
  "Theory",
]);

function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\s­‐-―−-]/g, "")
    .toLowerCase();
}

/** Fraction of `a` whose text also appears in `b` (substring either way). */
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const others = b.map((x) => norm(x.text)).filter((x) => x.length > 20);
  let hit = 0;
  for (const item of a) {
    const t = norm(item.text);
    if (t.length < 20) continue;
    if (others.some((o) => o.includes(t) || t.includes(o))) hit++;
  }
  return hit / a.length;
}

function describe(name, items, pageSpan) {
  const pages = new Set(items.map((i) => i.page));
  const thirds = [0, 0, 0];
  for (const i of items) {
    const t = Math.min(2, Math.floor((i.page / Math.max(1, pageSpan)) * 3));
    thirds[t]++;
  }
  const chars = items.map((i) => String(i.text || "").length);
  const mean = chars.length
    ? Math.round(chars.reduce((s, c) => s + c, 0) / chars.length)
    : 0;
  return {
    name,
    count: items.length,
    pagesCovered: pages.size,
    coverage: pageSpan ? `${pages.size}/${pageSpan}` : "n/a",
    distribution: thirds.join(" / "),
    meanChars: mean,
  };
}

const win = Zotero.getMainWindow();
const tabID = win.Zotero_Tabs.selectedID;
const reader = Zotero.Reader.getByTabID(tabID);
if (!reader) throw new Error("Open the document in a reader tab first");
const attachment = Zotero.Items.get(reader.itemID);

const annotations = attachment.getAnnotations();
const ours = [];
const theirs = [];
for (const a of annotations) {
  const tags = (a.getTags() || []).map((t) => t.tag);
  const entry = {
    text: a.annotationText || "",
    page: Number(String(a.annotationSortIndex || "0").split("|")[0]) || 0,
    color: a.annotationColor,
    tags,
  };
  if (tags.some((t) => SKIMREAD_TAGS.has(t))) ours.push(entry);
  else theirs.push(entry);
}

const pageSpan =
  Math.max(
    0,
    ...annotations.map(
      (a) => Number(String(a.annotationSortIndex || "0").split("|")[0]) || 0,
    ),
  ) + 1;

const rows = [
  describe("SkimRead", ours, pageSpan),
  describe("Other plugin", theirs, pageSpan),
];

let out = `Document: ${attachment.getField("title")}\n`;
out += `Annotations found: ${annotations.length} (SkimRead ${ours.length}, other ${theirs.length})\n\n`;
out += `| set | n | pages covered | start/mid/end | mean chars |\n`;
out += `|---|---|---|---|---|\n`;
for (const r of rows) {
  out += `| ${r.name} | ${r.count} | ${r.coverage} | ${r.distribution} | ${r.meanChars} |\n`;
}
out += `\nOverlap: ${(overlap(ours, theirs) * 100).toFixed(0)}% of SkimRead's picks also chosen by the other plugin`;
out += `\n         ${(overlap(theirs, ours) * 100).toFixed(0)}% the other way round\n`;
out += `\nToken cost is not comparable from annotations alone. SkimRead reports its own`;
out += `\nusage in the reader sidebar; record it there per run.\n`;
out += `\nFor the subjective half, pool both sets, strip which plugin produced each,`;
out += `\nshuffle, and mark every highlight keep / neutral / noise. Judging them`;
out += `\nside by side with labels visible measures loyalty, not quality.\n`;

return out;
