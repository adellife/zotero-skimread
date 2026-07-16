# Local Reader for Zotero

Local Reader adds document-wide AI skimming highlights to Zotero’s PDF reader.
It reads the paper as a whole, selects the sentences that best convey its
goal, method, results, and novelty, and shows them as coloured overlays in the
reader.

It is designed to work independently of other Zotero AI plugins.

## What it does

- Selects highlights in relation to the complete paper, not sentence by sentence.
- Uses the paper’s structure: references are excluded and section roles help
  guide selection.
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

1. Download `local-reader-0.1.0.xpi` from the latest
   [GitHub Release](../../releases/latest).
2. In Zotero, choose **Tools → Plugins**.
3. Select the gear menu, then **Install Plugin From File…**, and select the
   downloaded `.xpi`.
4. Restart Zotero.
5. Open **Settings → Local Reader**, choose a provider, and use **Test
   connection**.
6. Open a born-digital PDF and select **Local Reader** in the right sidebar.
   Choose **Generate**.

For a private setup, run Ollama locally and set its URL (normally
`http://localhost:11434`) and installed model names in Local Reader’s settings.

## Privacy

Local providers are the default and never send paper text off your machine.

OpenAI, Anthropic, and Codex App Server are optional cloud modes. Local Reader
will not use any of them until you explicitly enable the cloud-consent setting;
there is no silent fallback from a local provider to a cloud provider. API keys,
prompts, and provider transcripts are not logged or cached by the plugin.

## Status

Version 0.1.0 provides document-wide skimming highlights and native Zotero
annotation export. Citation cards and TLDRs are planned for a later release.

## Develop

```bash
npm install
npm run build
npm test
```

The production plugin is built at `.scaffold/build/local-reader.xpi`.

## License

[AGPL-3.0-or-later](LICENSE)
