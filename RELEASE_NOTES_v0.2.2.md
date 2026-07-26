Better selection, clearer settings, and a new icon.

## Selection

**A whole-document pass now decides what gets highlighted.** Until now each
passage was judged on its own and every passage's picks went straight to the
output, so nothing ever saw the document as a whole. A new pass reads all
candidates in reading order and marks the subset that together narrates the
document, dropping sentences that merely restate a point already made.

The per-passage quota is also softer. It used to demand a fixed number from
every passage, which forced boilerplate sections to yield their full share while
capping the section carrying the argument. It now asks for _up to_ that number.

Kept sentences are flagged rather than deleted, so the density slider means
something again: core sentences show first, and raising density adds context
around them instead of saturating at roughly two per page. The sidebar reports
how many were kept, for example `24 highlights across 9/12 pages · 11 core`.

**Sharper labels.** Each label now carries what it is _not_, plus a couple of
example sentences. Neighbouring categories (result vs novelty, goal vs
conclusion) are where smaller models go wrong most often, and stating the
exclusion separates them better than a longer description does. Custom labels
accept `antiDescription` and `examples` too.

## Fixes

- Highlights no longer start on the author byline. On a title page the byline
  runs into the abstract with no full stop, so the whole run was highlighted
  from the authors onward.
- Margin flags scale with the reader's zoom. They were a fixed size, so zooming
  in made them shrink relative to the text.
- The connection status line named Ollama whatever the provider was, and kept
  showing the previous one after a change. It now names the endpoint actually
  configured, refreshes when settings change, and can be clicked to re-check.
- The Claude model setting did nothing: the dropdown neither loaded nor saved,
  and could not be opened. Codex reasoning had the same fault silently.

## Settings

- Claude model is a proper picker (Sonnet / Haiku / Opus, with what each suits).
- Codex model is a picker too, populated from the Codex app server's own model
  list rather than hardcoded names.

## Annotations

Saved annotations now carry their label as a Zotero tag. Colour alone is lossy —
easy to change, ambiguous across a shared palette, and invisible to search —
while a tag keeps the category attached, filterable, and groupable in **Add Note
from Annotations**.

## Appearance

New icon: three highlight bands in the same palette the plugin paints, replacing
the previous mark. The sidebar version follows Zotero's theme.

## Install

Download `skim-read-0.2.2.xpi` below, then in Zotero: **Tools → Plugins →**
gear menu **→ Install Plugin From File…**, and restart Zotero.

Existing cached runs are regenerated on first use, since the prompts changed.
