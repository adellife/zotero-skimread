# SkimRead for Zotero

SkimRead adds document-wide AI skimming highlights to Zotero’s PDF reader.
It reads the paper as a whole, selects the sentences that best convey its
goal, method, results, and novelty, and shows them as coloured overlays in the
reader.

It is designed to work independently of other Zotero AI plugins.

## What it does

- Selects highlights in relation to the complete paper, not sentence by sentence.
- Uses the paper’s structure: references are excluded and section roles help
  guide selection.
- Handles long documents and books: when a document exceeds the provider’s
  context window, it is processed in context-sized parts that follow chapter
  and section boundaries, with progress shown and resumable runs. Papers that
  fit in one window are still selected in a single pass. Providers with very
  large context windows (1M+ tokens) can be used by raising the context
  setting, which reduces the number of parts.
- Runs privately with [Ollama](https://ollama.com) or a localhost-compatible
  server by default.
- Supports optional OpenAI API, Anthropic API, and ChatGPT/Codex App Server
  providers after an explicit cloud-consent choice.
- Keeps results in a local cache so a previously processed PDF can be reopened
  quickly.
- Lets you adjust labels, density, opacity, and margin labels.
- Keeps highlights temporary by default. **Save as Zotero annotations…** is an
  explicit action that creates standard Zotero highlights, which survive
  reopening and work with Zotero’s **Add Note from Annotations** command.

## Install

1. Download `skim-read.xpi` from the latest
   [GitHub Release](../../releases/latest).
2. In Zotero, choose **Tools → Plugins**.
3. Select the gear menu, then **Install Plugin From File…**, and select the
   downloaded `.xpi`.
4. Restart Zotero.
5. Open **Settings → SkimRead**, choose a provider, and use **Test
   connection**.
6. Open a born-digital PDF and select **SkimRead** in the right sidebar.
   Choose **Generate**.

## Using it

Open a PDF, open the **SkimRead** section in the reader’s right sidebar, and
press **Generate**. A status line reports progress and, when finished, shows a
summary such as `✓ Complete — 24 highlights from 812 sentences`. The
**Generate** button becomes **Reset & regenerate** once a run is cached, or
**Resume** if a run was interrupted.

- **Label mode** — _Default_ uses Goal / Method / Result / Novelty (the
  Semantic Reader scheme). _Custom_ lets you define your own labels in Settings
  (for example a _Theory_ label). _Auto-discover_ asks the model to read a
  sample of the document and propose 3–6 labels that fit it, which is useful
  for books and chapters where the default scheme does not apply.
- **Density / opacity / margin flags** — adjust how many highlights appear per
  page, how strong the colour is, and whether the label chips show in the
  margin. These re-apply instantly from cache without contacting the model.
- **Save as Zotero annotations…** converts the currently shown highlights into
  standard Zotero highlight annotations that persist and work with **Add Note
  from Annotations**. Nothing is written to your library until you use it.
- **TL;DR summary** generates a short 2–4 sentence summary of the paper with the
  TL;DR model and shows it in the sidebar. It is cached with the run; press again
  to refresh it.

## Providers

Choose one in **Settings → SkimRead → API type**, then **Test connection**.

### Ollama (local, default)

1. Install [Ollama](https://ollama.com) and start it (`ollama serve`).
2. Pull a model, e.g. `ollama pull llama3.1:8b`.
3. In Settings, set **Server URL** to `http://localhost:11434` and the
   **Skim model** to the model name you pulled.

Tip: give Ollama enough context to hold a whole paper. The **Context size**
setting controls `num_ctx`; if a paper is split into many parts, raise it (for
example to `32768`) provided your GPU has the memory. A remote Ollama server
can be reached through an SSH tunnel and still counts as local:
`ssh -N -L 11434:localhost:11434 you@server`.

### OpenAI-compatible local server (vLLM, llama.cpp, LM Studio)

Point **Server URL** at the server’s base address (the `/v1` suffix is added
automatically). Set **Skim model** to the served model name. This stays on
localhost and needs no cloud consent.

### OpenAI API / Anthropic API (cloud)

1. Tick **I understand that extracted PDF text will leave this computer**.
2. Paste your API key.
3. Set **Skim model** to a model your account can use, and adjust the **Cloud
   context budget** to the model’s context window.

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

## Troubleshooting

- **Test connection fails** — confirm the server is running and the URL is
  correct. For Ollama, check `ollama list` shows your model.
- **A run is very slow or produces nothing** — the model may not fit in memory
  and is spilling to CPU. Use a smaller model, or lower the context size.
- **A paper is split into many parts** — raise the context size (Ollama) or the
  cloud context budget so more of the document fits per pass.
- **No highlights on scanned PDFs** — SkimRead needs selectable text; run OCR
  on the PDF in Zotero first.

## Status

Version 0.1.0 provides document-wide skimming highlights, TL;DR summaries, and
native Zotero annotation export. Inline citation cards are planned for a later
release.

## Develop

```bash
npm install
npm run build     # → .scaffold/build/skim-read.xpi
```

The tests run inside Zotero. Copy `.env.example` to `.env` and set
`ZOTERO_PLUGIN_ZOTERO_BIN_PATH` to your Zotero binary, then:

```bash
npm test          # launches Zotero and runs the test suite
```

## Acknowledgements

SkimRead is an independent project (no code reused from the works below), built
on and inspired by:

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

## License

[AGPL-3.0-or-later](LICENSE)
