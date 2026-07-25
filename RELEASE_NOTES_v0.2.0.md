## Highlights

**EPUB support.** SkimRead now works on EPUBs as well as PDFs. Chapters are
highlighted in place using the browser's CSS Custom Highlight API, which colours
the text without inserting anything into the book, and margin-flag chips follow
the text across page turns and lazily-rendered chapters. The sidebar also lists
the selected passages so you can jump to them.

**Pause and resume long runs.** Books take a while, so runs can now be stopped
and continued:

- **Pause** keeps the highlights found so far on screen and saves progress.
- **Resume** continues without re-reading the document — extraction is cached,
  so no time or tokens are spent twice on work already done.
- **Cancel run** abandons a live or paused run and discards its progress, while
  **Clear** simply removes the overlays of a finished run.

**Auto-discover adapts to the document.** For an article it proposes one set of
labels up front. For EPUBs, books, theses and reports — detected from the Zotero
**Item Type** — labels evolve chapter by chapter, since a book's topics shift as
it goes.

## Fixes

- Pausing a run used to erase every highlight it had produced; Pause and Clear
  shared one handler. Pause now preserves the work.
- Pausing during text extraction did nothing at all: no save, no repaint, no
  message, and no Resume. This was most visible on PDFs, which spend much of a
  run extracting page by page.
- Sentences selected by the model sometimes never got highlighted. Quote
  matching is now normalised per character (NFKC, ligatures, curly quotes,
  whitespace and dash variants) with a shrinking-prefix fallback for quotes that
  drift from the rendered text.
- The adaptive selection schema lacked `additionalProperties: false` and was
  rejected outright by strict `json_schema` endpoints, so auto-discover mode
  produced no highlights at all on those providers.

## Other changes

- Providers simplified to a single OpenAI-compatible transport — covering
  Ollama, vLLM, LM Studio, OpenAI, Anthropic and other compatible endpoints —
  plus the two subscription CLIs (Codex App Server, Claude Code). The API key is
  optional, and non-localhost endpoints require explicit consent.
- Optional Ollama `num_ctx` setting, which uses the native `/api/chat` endpoint
  because the OpenAI-compatible one ignores it.

## Known limitations

- EPUB highlights cannot yet be exported as native Zotero annotations (PDFs can).
- Scanned PDFs need OCR first; SkimRead needs selectable text.

## Install

Download `skim-read-0.2.0.xpi` below, then in Zotero: **Tools → Plugins →**
gear menu **→ Install Plugin From File…**, and restart Zotero.

## Credits

Quote-matching normalisation is adapted from
[Nodus](https://github.com/Drakonis96/nodus) by Drakonis96 (MIT).
