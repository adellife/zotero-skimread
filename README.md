# SkimRead for Zotero

SkimRead adds document-wide AI skimming highlights to Zotero’s reader, for
both **PDFs and EPUBs**. It follows the document's narrative across its
sections or chapters, selects the sentences that best convey it, and shows
them as coloured overlays in the reader.

It is designed to work independently of other Zotero AI plugins.

It is a triage aid, not a summary and not a substitute for reading. Please see
[Limitations and bias](#limitations-and-bias) before relying on it.

## What it does

- Selects highlights in relation to the complete document, not sentence by sentence.
- Works with **PDFs and EPUBs**. EPUB chapters are highlighted in place using
  the browser’s CSS Custom Highlight API, which colours the text without
  inserting anything into the book, and a clickable list of the selected
  passages is shown in the sidebar for navigation.
- Uses the paper’s structure: references are excluded and section roles help
  guide selection.
- Handles long documents and books: when a document exceeds the provider’s
  context window, it is processed in context-sized parts that follow chapter
  and section boundaries. A run can be **paused and resumed** at any point —
  highlights found so far stay on screen, and resuming skips re-reading the
  document. Papers that
  fit in one window are still selected in a single pass. Providers with very
  large context windows (1M+ tokens) can be used by raising the context
  setting, which reduces the number of parts.
- Runs privately with [Ollama](https://ollama.com) or a localhost-compatible
  server by default.
- Supports local or cloud OpenAI-compatible servers, including API providers
  that expose a compatible endpoint, plus ChatGPT/Codex or Claude subscription
  logins. Anything remote requires explicit cloud consent.
- Keeps results in a local cache so a previously processed PDF can be reopened
  quickly.
- Lets you switch between the core narrative and optional supporting context,
  and adjust labels, opacity, and margin labels.
- Keeps highlights temporary by default. **Save as Zotero annotations…** is an
  explicit action that creates standard Zotero highlights, which survive
  reopening and work with Zotero’s **Add Note from Annotations** command.

## Install

1. Download `skim-read.xpi` from the latest
   [GitHub Release](../../releases/latest).
2. In Zotero, choose **Tools → Plugins**.
3. Select the gear menu, then **Install Plugin From File…**, and select the
   downloaded `.xpi`.
4. Open **Settings → SkimRead**, choose a provider, and use **Test
   connection**.
5. Open a born-digital PDF and select **SkimRead** in the right sidebar.
   Choose **Generate**.

A first installation does not normally require restarting Zotero. To replace a
manually installed older build, remove the old plugin, restart Zotero, and then
install the new `.xpi`.

## Quick start for new users

You do not need to own a powerful computer or pay for a model before trying
SkimRead:

- For the most private setup, use **Ollama**. The paper stays on your computer,
  but you must install a model locally; an 8B model or larger is a better
  starting point for judging a paper's narrative than a very small model.
- If you cannot run a local model, use an OpenAI-compatible cloud API. Some
  providers offer free tiers or trial credits. For example,
  [OpenRouter's free router](https://openrouter.ai/openrouter/free) can select
  from currently available free models.

To try OpenRouter, create an OpenRouter API key and enter:

1. **Provider:** OpenAI-compatible
2. **Server URL:** `https://openrouter.ai/api/v1`
3. **API key:** your OpenRouter key
4. **Reader model:** `openrouter/free`
5. Enable **I understand that extracted PDF text will leave this computer**,
   then select **Test connection**.

Free models are useful for trying the plugin, but availability, rate limits,
context capacity, and selection quality can vary. The free router may use a
different model between requests, so a fixed model from OpenRouter or another
cloud API may give more consistent results. Always review a provider's current
pricing, privacy policy, and data-handling terms before sending a document.

After generation, choose **Core narrative** in the reader sidebar for the
smallest set of sentences that carries the document's story, or **Core +
supporting context** to also show evidence, explanation, and examples. This
switch uses the cached result and does not send the paper to the model again.

## Using it

Open a PDF or EPUB, open the **SkimRead** section in the reader’s right
sidebar, and press **Generate**. A status line reports progress and, when
finished, shows a summary such as `✓ Complete — 24 highlights from 812
sentences`. The **Generate** button becomes **Reset & regenerate** once a run
is cached.

- **Pause / Resume / Cancel run** — long books can be stopped at any time.
  **Pause** keeps the highlights found so far on screen and saves progress;
  the button then becomes **Resume**, which continues without re-reading the
  document or re-spending tokens on work already done. **Cancel run** (the
  third button, while a run is live or paused) abandons the run and discards
  its progress. **Clear** simply removes the overlays of a finished run.
- **Label mode** — _Default_ uses Goal / Method / Result / Novelty (the
  Semantic Reader scheme). _Custom_ lets you define your own labels in Settings
  (for example a _Theory_ label). _Auto-discover_ adapts to the document type:
  for an article it proposes a single set of labels up front, while for EPUBs,
  books, theses and reports (detected from the Zotero **Item Type**) labels
  evolve chapter by chapter, since topics shift across a book.
- **Reading highlights** — _Core narrative_ shows the smallest set selected to
  tell the paper's story. _Core + supporting context_ also reveals useful
  evidence, explanation, and examples. Opacity and margin flags re-apply
  instantly from cache without contacting the model.
- **Save as Zotero annotations…** converts the currently shown highlights into
  standard Zotero highlight annotations that persist and work with **Add Note
  from Annotations**. In Settings, choose whether each rhetorical label is
  written into the annotation comment (the default, visible in extracted
  notes), saved as a tag for filtering, or not saved. Comment labels contain
  only the label name by default; an optional setting adds the `SkimRead:`
  prefix. Nothing is written to your library until you use it.
- **TL;DR summary** generates a short 2–4 sentence summary of the paper with the
  selected reader model and shows it in the sidebar. It is cached with the run;
  press again to refresh it.

### What you can customize

In **Settings → SkimRead**, you can change:

- The provider, server URL, API key, cloud consent, and reader model.
- The context budget, which controls how much text is considered in each
  document part. Ollama also has a separate context-length setting for the
  model server; larger values use more GPU memory.
- Custom rhetorical labels and their descriptions for the reader's **Custom**
  label mode.
- Whether labels on saved Zotero annotations are placed in the comment, saved
  as tags, or omitted, and whether comments include the `SkimRead:` prefix.

In the **SkimRead reader sidebar**, you can change:

- The label mode: **Default**, **Custom**, or **Auto-discover**.
- Which individual labels are visible.
- **Core narrative** or **Core + supporting context**.
- Highlight opacity and whether margin flags are shown.
- Whether a TL;DR is generated together with the skim.

## Providers

Choose one in **Settings → SkimRead → API type**, then **Test connection**.

### Ollama (local, default)

1. Install [Ollama](https://ollama.com) and start it (`ollama serve`).
2. Pull a model, e.g. `ollama pull llama3.1:8b`.
3. In Settings, set **Server URL** to `http://localhost:11434` and the
   **Reader model** to the model name you pulled. The same model handles
   highlights and TL;DRs, so local setup only loads one model.

Tip: give Ollama enough context to hold a whole paper. The **Context size**
setting controls `num_ctx`; if a paper is split into many parts, raise it (for
example to `32768`) provided your GPU has the memory.

### OpenAI-compatible local server (vLLM, llama.cpp, LM Studio)

Point **Server URL** at the server’s base address (the `/v1` suffix is added
automatically). Set **Reader model** to the served model name. This stays on
localhost and needs no cloud consent.

### OpenAI-compatible cloud APIs

This mode supports services such as OpenRouter, OpenAI, Anthropic-compatible
endpoints, and other providers that expose an OpenAI-compatible
`/v1/chat/completions` API.

1. Tick **I understand that extracted PDF text will leave this computer**.
2. Enter the provider's base URL and paste your API key.
3. Set **Reader model** to a model your account can use, and adjust the
   **Context budget** to the model's context window.

Free tiers and trial credits may be available from some providers, but their
limits and terms change. See the [Quick start for new
users](#quick-start-for-new-users) for an OpenRouter free-model example.

### Codex App Server (ChatGPT login)

Runs selection through your local Codex CLI using your ChatGPT session — no API
key required.

1. Install the Codex CLI and sign in once with `codex login`.
2. In Settings, choose **Codex App Server**, tick the cloud-consent box, set a
   **Codex model** and reasoning effort. If Codex is not on your `PATH`, set the
   **Codex CLI path** (for example
   `/Applications/ChatGPT.app/Contents/Resources/codex`).

SkimRead opens a short-lived, read-only Codex thread only for the structured
whole-paper selection. It does not expose Zotero, your files, chat, or notes to
Codex, and keeps nothing after the result is cached.

### Claude Code (Claude subscription login)

Runs selection through your local Claude Code CLI using your Claude Pro/Max
subscription — no API key required.

1. Install Claude Code and sign in once with `claude login`.
2. In Settings, choose **Claude Code**, tick the cloud-consent box, and set a
   **Claude model** (an alias like `sonnet` or `opus`, or a full model ID). If
   `claude` is not on your `PATH`, set the **Claude CLI path**.

SkimRead runs the CLI headlessly for a single structured request with tools
disabled, so Claude cannot read files, run commands, or touch Zotero. No API key
is read or stored, and nothing is kept after the result is cached.

## Privacy

Local providers are the default and never send paper text off your machine.

OpenAI, Anthropic, and Codex App Server are optional cloud modes. SkimRead
will not use any of them until you explicitly enable the cloud-consent setting;
there is no silent fallback from a local provider to a cloud provider. API keys,
prompts, and provider transcripts are not logged or cached by the plugin.

## Limitations and bias

SkimRead decides what to show you, which means it also decides what you do not
look at. Three things are worth knowing:

- **What is not highlighted disappears.** The strongest bias is the one you
  cannot see: an argument the model judged unimportant simply never draws your
  eye.
- **The default scheme carries a discipline bias.** Goal / Method / Result /
  Novelty describes empirical, IMRaD-shaped research. Humanities and theory
  work fit it poorly, so use _Custom_ labels or _Auto-discover_ there.
- **Extraction drops text before the model sees it.** Running heads, footers
  and small-font footnotes are discarded as page furniture, and unusual
  two-column layouts can be read out of order. Footnotes carry the argument in
  much historical and legal scholarship, and SkimRead cannot highlight what it
  never extracted.

Smaller local models are reliable at picking sentences and less reliable at
judging which deserve picking. Treat this as a way to decide what to read, not
as a substitute for reading it.

## Troubleshooting

- **Test connection fails** — confirm the server is running and the URL is
  correct. For Ollama, check `ollama list` shows your model.
- **A run is very slow or produces nothing** — the model may not fit in memory
  and is spilling to CPU. Use a smaller model, or lower the context size.
- **A paper is split into many parts** — raise the context size (Ollama) or the
  cloud context budget so more of the document fits per pass.
- **No highlights on scanned PDFs** — SkimRead needs selectable text; run OCR
  on the PDF in Zotero first.
- **Some EPUB annotations are skipped** — Zotero can save only passages from
  chapters the reader has rendered. Scroll through the book once, then use
  **Save as Zotero annotations…** again.

## Acknowledgements

SkimRead is an independent project, built on and inspired by the works below.
Except where a source file states otherwise, no code is reused from them:

- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
  by windingwind — the scaffold and build workflow SkimRead is based on.
- [Semantic Reader](https://www.semanticscholar.org/product/semantic-reader) and
  the [Scim](https://cacm.acm.org/research/the-semantic-reader-project/) project
  by the Allen Institute for AI — the skimming-highlight experience and the
  Goal / Method / Result / Novelty scheme are modeled on their research.
- [llm-for-zotero](https://github.com/yilewang/llm-for-zotero) by Yile Wang —
  SkimRead is designed to run alongside it without overlapping its features, and
  its local-CLI provider integrations (Codex App Server, Claude Code) were a
  reference point for SkimRead's own subscription-login providers.
- [zotero-skimming](https://github.com/00sapo/zotero-skimming) by 00sapo — an
  independent plugin with the same goal, developed in parallel and worth trying
  alongside this one.
- [Nodus](https://github.com/Drakonis96/nodus) by Drakonis96 (MIT) — its
  Zotero auto-highlighter demonstrated a robust way to match model-quoted text
  back to the document. SkimRead's quote normalisation (NFKC, ligatures, quote
  and dash variants) and shrinking-prefix fallback are adapted from it; the
  relevant function in `src/reader/adapter.ts` carries the attribution.

## License

[AGPL-3.0-or-later](LICENSE)

Developers who want to modify or build SkimRead can follow the separate
[contributor guide](CONTRIBUTING.md).
