Completes the EPUB support introduced in 0.2.0.

## Added

**EPUB highlights can now be saved as native Zotero annotations.** 0.2.0 shipped
EPUB highlighting with this listed as a known limitation. It turned out not to be
a real limitation: the reader view can produce a Zotero annotation directly from
a DOM range, including the EPUB CFI position, and the overlay painter already
builds exactly those ranges. **Save as Zotero annotations…** now works for EPUBs
as it does for PDFs, and the results work with Zotero's **Add Note from
Annotations** command.

Because CFIs are generated from live ranges, only passages in chapters the
reader has already rendered can be converted. Any that cannot are reported
("6 skipped (chapter not rendered yet)") rather than silently omitted. Scrolling
through the book once resolves it.

Saving remains explicit and opt-in. Nothing is written to your library until you
press the button.

## Documentation

Added a **Limitations and bias** section to the README. Choosing what to
highlight also decides what you do not look at, which is worth stating plainly.
It covers the discipline bias of the default Goal / Method / Result / Novelty
scheme, the text dropped during extraction (footnotes especially, which carry
the argument in historical and legal scholarship), weaker judgement from small
models, and the fact that what is not highlighted simply disappears.

## Install

Download `skim-read-0.2.1.xpi` below, then in Zotero: **Tools → Plugins →**
gear menu **→ Install Plugin From File…**, and restart Zotero.
