# Contributing to SkimRead

This page is only for developers who want to change SkimRead's source code.
Installing and using the plugin does not require any of these steps.

## Build the plugin

Install [Node.js](https://nodejs.org), then run:

```bash
npm install
npm run build
```

`npm install` downloads the project's development tools. `npm run build`
checks the TypeScript code and creates the installable plugin at
`.scaffold/build/skim-read.xpi`.

## Run the tests

SkimRead's tests run inside Zotero because they use Zotero's reader APIs.

1. Copy `.env.example` to a new file named `.env`.
2. Set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` to the Zotero executable. On macOS this
   is normally `/Applications/Zotero.app/Contents/MacOS/zotero`.
3. Set `ZOTERO_PLUGIN_PROFILE_PATH` to a separate Zotero profile intended for
   development.
4. Run:

```bash
npm test
```

This launches Zotero with the test profile and runs the plugin test suite.
