/**
 * Reader sidebar section with dynamic label sets:
 * mode selector (Default / Custom / Auto-discover), per-label toggles with
 * counts, margin-flag toggle, Generate/Regenerate + Clear, sliders.
 * Highlights run ONLY from the Generate button; overlays are ephemeral.
 */
import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { checkStatus, missingModels } from "../llm/ollama";
import {
  getReaderForTab,
  navigateToText,
  HighlightSpec,
} from "../reader/adapter";
import {
  cacheState,
  cacheSummary,
  cancelSkim,
  clearHighlights,
  discardSkim,
  generateTldr,
  getCachedHighlights,
  getCachedLabels,
  getCachedTldr,
  getConfiguredLabels,
  getLabelMode,
  hasCachedRun,
  hasSavedAnnotations,
  isRunning,
  runSkim,
  saveSkimAsAnnotations,
  saveTldrAsNote,
  LabelMode,
} from "./skim";
import { LabelDef } from "../prompts/skim";

const MODES: { value: LabelMode; label: string }[] = [
  { value: "default", label: "Default (Goal/Method/Result/Novelty)" },
  { value: "custom", label: "Custom (edit in Settings)" },
  { value: "auto", label: "Auto-discover from document" },
];

export function registerReaderSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "skimread-panel",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("reader-section-head"),
      icon: `chrome://${config.addonRef}/content/icons/skimread-sidenav.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("reader-section-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/skimread-sidenav.svg`,
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader");
      return true;
    },
    onRender: ({ body }) => {
      renderPanel(body);
    },
    onAsyncRender: async ({ body }) => {
      await refreshStatus(body);
      await refreshButtons(body);
      await renderLabelRows(body, null);
      await refreshRunSummary(body);
      await restoreTldr(body);
      await restoreHighlightList(body);
    },
  });
}

function currentContext(body: HTMLElement) {
  const win = body.ownerDocument!.defaultView as any;
  const tabID = win?.Zotero_Tabs?.selectedID as string;
  const reader = tabID ? getReaderForTab(tabID) : null;
  const attachment = reader ? Zotero.Items.get(reader.itemID) : null;
  return { tabID, reader, attachment };
}

function hiddenLabels(): Set<string> {
  try {
    const arr = JSON.parse(String(getPref("hiddenLabels") || "[]"));
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function setHidden(key: string, hidden: boolean) {
  const set = hiddenLabels();
  if (hidden) set.add(key);
  else set.delete(key);
  setPref("hiddenLabels", JSON.stringify([...set]));
}

function renderPanel(body: HTMLElement) {
  body.replaceChildren();
  const doc = body.ownerDocument!;

  const wrap = doc.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:4px 0;";

  const status = doc.createElement("div");
  status.id = "skimread-status";
  status.textContent = getString("status-checking");
  status.style.cssText = "font-size:12px;";
  wrap.append(status);

  // label mode selector
  const modeRow = doc.createElement("div");
  modeRow.style.cssText =
    "display:flex;flex-direction:column;gap:2px;font-size:12px;";
  const modeLab = doc.createElement("span");
  modeLab.textContent = getString("control-mode");
  const select = doc.createElement("select");
  select.id = "skimread-mode";
  select.style.cssText = "font-size:12px;";
  for (const m of MODES) {
    const opt = doc.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    select.append(opt);
  }
  select.value = getLabelMode();
  select.addEventListener("change", () => {
    setPref("labelMode", select.value);
    void refreshButtons(body);
    void renderLabelRows(body, null);
    setProgress(body, getString("progress-mode-changed"));
  });
  modeRow.append(modeLab, select);
  wrap.append(modeRow);

  // balanced coverage toggle (hierarchical map-reduce selection)
  const balRow = doc.createElement("label");
  balRow.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:12px;";
  const balCb = doc.createElement("input");
  balCb.type = "checkbox";
  balCb.checked = getPref("balancedCoverage") !== false;
  balCb.addEventListener("change", () =>
    setPref("balancedCoverage", balCb.checked),
  );
  balRow.append(balCb, doc.createTextNode(getString("control-balanced")));
  wrap.append(balRow);

  // action buttons
  const btnRow = doc.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;";
  const genBtn = doc.createElement("button");
  genBtn.id = "skimread-generate";
  genBtn.textContent = getString("btn-generate");
  genBtn.style.cssText = "font-size:12px;padding:3px 10px;";
  const cancelBtn = doc.createElement("button");
  cancelBtn.id = "skimread-cancel";
  cancelBtn.textContent = getString("btn-cancel");
  cancelBtn.style.cssText = "font-size:12px;padding:3px 10px;display:none;";
  const clearBtn = doc.createElement("button");
  clearBtn.id = "skimread-clear";
  clearBtn.textContent = getString("btn-clear");
  clearBtn.style.cssText = "font-size:12px;padding:3px 10px;";
  btnRow.append(genBtn, cancelBtn, clearBtn);
  wrap.append(btnRow);

  const saveBtn = doc.createElement("button");
  saveBtn.id = "skimread-save-annotations";
  saveBtn.textContent = "Save as Zotero annotations…";
  saveBtn.style.cssText =
    "font-size:12px;padding:3px 10px;align-self:flex-start;";
  saveBtn.disabled = true;
  wrap.append(saveBtn);
  const saveHint = doc.createElement("div");
  saveHint.style.cssText = "font-size:11px;opacity:0.7;margin-top:-5px;";
  saveHint.textContent =
    "Optional: creates normal Zotero highlights that can be extracted into a note.";
  wrap.append(saveHint);

  // TL;DR
  const tldrBtn = doc.createElement("button");
  tldrBtn.id = "skimread-tldr";
  tldrBtn.textContent = getString("btn-tldr");
  tldrBtn.style.cssText =
    "font-size:12px;padding:3px 10px;align-self:flex-start;margin-top:4px;";
  wrap.append(tldrBtn);
  const tldrWithRow = doc.createElement("label");
  tldrWithRow.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:11px;opacity:0.85;";
  const tldrWithCb = doc.createElement("input");
  tldrWithCb.type = "checkbox";
  tldrWithCb.checked = getPref("tldrWithSkim") === true;
  tldrWithCb.addEventListener("change", () =>
    setPref("tldrWithSkim", tldrWithCb.checked),
  );
  tldrWithRow.append(
    tldrWithCb,
    doc.createTextNode(getString("control-tldr-with")),
  );
  wrap.append(tldrWithRow);
  const tldrBox = doc.createElement("div");
  tldrBox.id = "skimread-tldr-box";
  tldrBox.style.cssText =
    "font-size:12px;line-height:1.4;white-space:pre-wrap;" +
    "background:rgba(127,127,127,0.08);border-radius:4px;padding:0;margin:0;" +
    "max-height:0;overflow:hidden;transition:none;";
  wrap.append(tldrBox);
  const tldrNoteBtn = doc.createElement("button");
  tldrNoteBtn.id = "skimread-tldr-note";
  tldrNoteBtn.textContent = getString("btn-tldr-note");
  tldrNoteBtn.style.cssText =
    "font-size:11px;padding:2px 8px;align-self:flex-start;display:none;";
  wrap.append(tldrNoteBtn);
  tldrBtn.addEventListener("click", () => void onTldr(body));
  tldrNoteBtn.addEventListener("click", () => void onTldrNote(body));

  const progress = doc.createElement("div");
  progress.id = "skimread-progress";
  progress.style.cssText = "font-size:11px;opacity:0.8;min-height:14px;";
  wrap.append(progress);

  genBtn.addEventListener("click", () => onGenerate(body));
  // Shared Pause/Resume slot: pauses a live run, or continues a paused one.
  cancelBtn.addEventListener("click", () => {
    const { tabID } = currentContext(body);
    if (!tabID) return;
    if (isRunning(tabID)) {
      // Pause only: highlights painted so far stay on screen (Clear removes them).
      cancelSkim(tabID);
      // Cancellation is cooperative: the in-flight request still has to finish,
      // which can take a while on a big model. Show that immediately instead of
      // leaving a "Pause" button that appears to do nothing.
      cancelBtn.textContent = getString("btn-pausing");
      (cancelBtn as HTMLButtonElement).disabled = true;
      setProgress(body, getString("progress-cancelling"));
    } else {
      void onGenerate(body, true); // resume from the partial cache
    }
  });
  // Contextual: cancels and discards an in-progress/paused run, otherwise just
  // removes the overlays of a finished run (whose results are worth keeping).
  clearBtn.addEventListener("click", () => {
    void (async () => {
      const { tabID, attachment } = currentContext(body);
      if (!tabID) return;
      const abandonable =
        attachment &&
        (isRunning(tabID) || (await cacheState(attachment)) === "partial");
      if (abandonable) {
        await discardSkim(tabID, attachment);
        setProgress(body, getString("progress-run-cancelled"));
      } else {
        clearHighlights(tabID);
        setProgress(body, getString("progress-cleared"));
      }
      renderHighlightList(body, []);
      await refreshButtons(body);
      await refreshRunSummary(body);
    })();
  });
  saveBtn.addEventListener("click", () => {
    void onSaveAnnotations(body);
  });

  // dynamic label rows
  const labelBox = doc.createElement("div");
  labelBox.id = "skimread-labels";
  labelBox.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  wrap.append(labelBox);

  // margin flags toggle
  const flagRow = doc.createElement("label");
  flagRow.style.cssText =
    "display:flex;align-items:center;gap:6px;font-size:12px;";
  const flagCb = doc.createElement("input");
  flagCb.type = "checkbox";
  flagCb.checked = getPref("showFlags") !== false;
  flagCb.addEventListener("change", () => {
    setPref("showFlags", flagCb.checked);
    repaintFromCacheIfAny(body);
  });
  flagRow.append(flagCb, doc.createTextNode(getString("control-flags")));
  wrap.append(flagRow);

  wrap.append(
    makeSlider(
      doc,
      getString("control-density"),
      "highlightDensity",
      1,
      10,
      body,
    ),
    makeSlider(
      doc,
      getString("control-opacity"),
      "highlightOpacity",
      10,
      80,
      body,
    ),
  );

  // EPUB highlight list (populated on async render / after a run).
  const hlList = doc.createElement("div");
  hlList.id = "skimread-hl-list";
  hlList.style.cssText =
    "display:flex;flex-direction:column;gap:4px;margin-top:6px;";
  wrap.append(hlList);

  body.append(wrap);
}

function isEpubContext(body: HTMLElement): boolean {
  return currentContext(body).reader?.type === "epub";
}

/** Repopulate the EPUB highlight list from cache when the pane re-renders. */
async function restoreHighlightList(body: HTMLElement) {
  if (!isEpubContext(body)) return;
  const { attachment } = currentContext(body);
  if (!attachment) return;
  renderHighlightList(body, await getCachedHighlights(attachment));
}

/** EPUB: render selected highlights as a clickable, jump-to list. */
function renderHighlightList(body: HTMLElement, specs: HighlightSpec[]) {
  const box = body.querySelector("#skimread-hl-list") as HTMLElement | null;
  if (!box) return;
  const doc = body.ownerDocument!;
  box.replaceChildren();
  if (!specs.length) return;
  const { reader } = currentContext(body);
  const ordered = [...specs].sort(
    (a, b) => a.pageIndex - b.pageIndex || a.startChar - b.startChar,
  );
  for (const spec of ordered) {
    const row = doc.createElement("div");
    row.style.cssText =
      "display:flex;gap:6px;font-size:12px;line-height:1.35;cursor:pointer;" +
      "padding:4px 6px;border-radius:4px;border-left:3px solid rgb(" +
      spec.colorRGB +
      ");background:rgba(127,127,127,0.06);";
    const dot = doc.createElement("span");
    dot.style.cssText = `flex:0 0 auto;width:9px;height:9px;margin-top:3px;border-radius:2px;background:rgba(${spec.colorRGB},0.85);`;
    const txt = doc.createElement("span");
    txt.textContent =
      spec.text.length > 160 ? spec.text.slice(0, 158) + "…" : spec.text;
    row.append(dot, txt);
    row.addEventListener("click", () => {
      if (reader) navigateToText(reader, spec.text);
    });
    box.append(row);
  }
}

/**
 * Render per-label toggle rows. `labels` explicit (post-run), else cached
 * labels for this document, else configured labels; in auto mode with no
 * cache yet, show a hint instead.
 */
async function renderLabelRows(body: HTMLElement, labels: LabelDef[] | null) {
  const box = body.querySelector("#skimread-labels") as HTMLElement | null;
  if (!box) return;
  const doc = body.ownerDocument!;
  if (!labels) {
    const { attachment } = currentContext(body);
    if (attachment) labels = await getCachedLabels(attachment);
    if (!labels) labels = getConfiguredLabels();
  }
  box.replaceChildren();
  if (!labels) {
    const hint = doc.createElement("div");
    hint.style.cssText = "font-size:11px;opacity:0.7;";
    hint.textContent = getString("hint-auto-labels");
    box.append(hint);
    return;
  }
  const hidden = hiddenLabels();
  for (const l of labels) {
    const row = doc.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;font-size:12px;";
    const cb = doc.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hidden.has(l.key);
    cb.addEventListener("change", () => {
      setHidden(l.key, !cb.checked);
      repaintFromCacheIfAny(body);
    });
    const dot = doc.createElement("span");
    dot.style.cssText = `width:10px;height:10px;border-radius:2px;display:inline-block;background:rgba(${l.color},0.75);`;
    const count = doc.createElement("span");
    count.id = `skimread-count-${l.key}`;
    count.style.cssText = "opacity:0.6;";
    row.append(cb, dot, doc.createTextNode(l.name), count);
    box.append(row);
  }
}

function setProgress(body: HTMLElement, msg: string) {
  const el = body.querySelector("#skimread-progress") as HTMLElement | null;
  if (el) el.textContent = msg;
}

function setCounts(body: HTMLElement, counts: Record<string, number>) {
  for (const [key, n] of Object.entries(counts)) {
    const el = body.querySelector(
      `#skimread-count-${key}`,
    ) as HTMLElement | null;
    if (el) el.textContent = n ? ` (${n})` : "";
  }
}

function callbacks(body: HTMLElement) {
  return {
    onStatus: (msg: string) => setProgress(body, msg),
    onDone: (count: number) =>
      setProgress(body, getString("progress-done", { args: { count } })),
    onError: (msg: string) => setProgress(body, `⚠ ${msg}`),
    onCounts: (counts: Record<string, number>) => setCounts(body, counts),
    onLabels: (labels: LabelDef[]) => {
      void renderLabelRows(body, labels);
    },
    onTldr: (tldr: string) => {
      showTldr(body, tldr);
      const btn = body.querySelector(
        "#skimread-tldr",
      ) as HTMLButtonElement | null;
      if (btn) btn.textContent = getString("btn-tldr-refresh");
    },
    onHighlights: (specs: HighlightSpec[]) => renderHighlightList(body, specs),
  };
}

/**
 * Start a run. `resume` continues a paused run from its partial cache; without
 * it, an existing run (partial or complete) is reset and regenerated, matching
 * what the Generate button says in each state.
 */
async function onGenerate(body: HTMLElement, resume = false) {
  const { tabID, reader, attachment } = currentContext(body);
  if (!tabID || !reader || !attachment) {
    setProgress(body, getString("progress-no-reader"));
    return;
  }
  if (isRunning(tabID)) {
    setProgress(body, getString("progress-already-running"));
    return;
  }
  const genBtn = body.querySelector(
    "#skimread-generate",
  ) as HTMLButtonElement | null;
  const runCtrl = body.querySelector("#skimread-cancel") as HTMLElement | null;
  const regenerate = resume ? false : (await cacheState(attachment)) !== "none";
  if (genBtn) genBtn.disabled = true;
  // The shared slot shows Pause for the duration of the run.
  if (runCtrl) {
    runCtrl.textContent = getString("btn-cancel");
    runCtrl.style.display = "";
  }
  await runSkim(reader, tabID, attachment, callbacks(body), regenerate);
  if (genBtn) genBtn.disabled = false;
  // refreshButtons decides whether the slot becomes Resume or hides.
  await refreshButtons(body);
  await refreshRunSummary(body);
}

async function onSaveAnnotations(body: HTMLElement) {
  const { reader, attachment } = currentContext(body);
  if (!reader || !attachment) {
    setProgress(body, getString("progress-no-reader"));
    return;
  }
  const win = body.ownerDocument?.defaultView;
  if (
    !win?.confirm(
      "Save the currently visible SkimRead highlights as standard Zotero annotations? You can then use Zotero’s Add Note from Annotations command.",
    )
  ) {
    return;
  }
  const saveBtn = body.querySelector(
    "#skimread-save-annotations",
  ) as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  setProgress(body, "Saving Zotero annotations…");
  try {
    const result = await saveSkimAsAnnotations(reader, attachment);
    // EPUBs can only convert passages in already-rendered chapters, so say so
    // rather than quietly saving fewer than the user can see.
    const skippedNote = result.skipped
      ? ` ${result.skipped} skipped (chapter not rendered yet).`
      : "";
    setProgress(
      body,
      result.alreadySaved
        ? `${result.saved} Zotero annotations already saved.`
        : `Saved ${result.saved} Zotero annotations.${skippedNote}`,
    );
  } catch (error) {
    setProgress(body, `⚠ ${String((error as Error).message || error)}`);
  } finally {
    await refreshButtons(body);
  }
}

function showTldr(body: HTMLElement, text: string) {
  const box = body.querySelector("#skimread-tldr-box") as HTMLElement | null;
  if (!box) return;
  box.textContent = text;
  box.style.maxHeight = text ? "none" : "0";
  box.style.padding = text ? "8px 10px" : "0";
  box.style.marginTop = text ? "6px" : "0";
  const noteBtn = body.querySelector(
    "#skimread-tldr-note",
  ) as HTMLElement | null;
  if (noteBtn) noteBtn.style.display = text ? "" : "none";
}

async function onTldrNote(body: HTMLElement) {
  const { attachment } = currentContext(body);
  if (!attachment) return;
  const btn = body.querySelector(
    "#skimread-tldr-note",
  ) as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const result = await saveTldrAsNote(attachment);
    setProgress(
      body,
      result === "saved"
        ? getString("progress-tldr-note-saved")
        : getString("progress-tldr-none"),
    );
  } catch (error) {
    setProgress(body, `⚠ ${String((error as Error).message || error)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function restoreTldr(body: HTMLElement) {
  const { attachment } = currentContext(body);
  if (!attachment) return;
  const cached = await getCachedTldr(attachment);
  const btn = body.querySelector("#skimread-tldr") as HTMLButtonElement | null;
  if (cached) {
    showTldr(body, cached);
    if (btn) btn.textContent = getString("btn-tldr-refresh");
  }
}

async function onTldr(body: HTMLElement) {
  const { reader, attachment } = currentContext(body);
  if (!reader || !attachment) {
    setProgress(body, getString("progress-no-reader"));
    return;
  }
  const btn = body.querySelector("#skimread-tldr") as HTMLButtonElement | null;
  // If a summary is already shown, this button regenerates it.
  const force = !!(await getCachedTldr(attachment));
  if (btn) btn.disabled = true;
  setProgress(body, getString("progress-tldr"));
  try {
    const tldr = await generateTldr(
      reader,
      attachment,
      (msg) => setProgress(body, msg),
      force,
    );
    showTldr(body, tldr);
    setProgress(body, "");
    if (btn) btn.textContent = getString("btn-tldr-refresh");
  } catch (error) {
    setProgress(body, `⚠ ${String((error as Error).message || error)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Persistent idle status: tells the reader whether the cached run finished,
 * without depending on transient progress messages.
 */
async function refreshRunSummary(body: HTMLElement) {
  const { tabID, attachment } = currentContext(body);
  if (!attachment || (tabID && isRunning(tabID))) return;
  const summary = await cacheSummary(attachment);
  const tokens =
    summary.tokensInput || summary.tokensOutput
      ? ` · ${summary.tokensInput.toLocaleString()} in / ${summary.tokensOutput.toLocaleString()} out tokens`
      : "";
  const coverage = summary.pageSpan
    ? ` across ${summary.pagesCovered}/${summary.pageSpan} pages`
    : "";
  if (summary.state === "complete") {
    setProgress(
      body,
      `✓ Complete — ${summary.selections} highlights${coverage}${tokens}`,
    );
  } else if (summary.state === "partial") {
    setProgress(
      body,
      `◐ Partial — ${summary.considered} sentences processed${tokens}. Generate resumes.`,
    );
  }
}

function repaintFromCacheIfAny(body: HTMLElement) {
  const { tabID, reader, attachment } = currentContext(body);
  if (!tabID || !reader || !attachment || isRunning(tabID)) return;
  void hasCachedRun(attachment).then((cached) => {
    if (!cached) return;
    void runSkim(reader, tabID, attachment, callbacks(body));
  });
}

/**
 * Reflect run state in the buttons:
 * - Generate: "Generate highlights" when nothing is cached, else "Reset & regenerate".
 * - Shared slot: "Pause" while running, "Resume" when a paused run exists, else hidden.
 * Pause and Resume deliberately occupy the same slot, so a run is stopped and
 * continued from the same place.
 */
async function refreshButtons(body: HTMLElement) {
  const { tabID, attachment } = currentContext(body);
  const genBtn = body.querySelector(
    "#skimread-generate",
  ) as HTMLButtonElement | null;
  if (!genBtn || !attachment) return;
  const state = await cacheState(attachment);
  genBtn.textContent =
    state === "none" ? getString("btn-generate") : getString("btn-regenerate");

  const running = tabID ? isRunning(tabID) : false;
  // Clear doubles as the "abandon this run" action while one is live/paused.
  const clearBtn = body.querySelector(
    "#skimread-clear",
  ) as HTMLButtonElement | null;
  if (clearBtn) {
    clearBtn.textContent =
      running || state === "partial"
        ? getString("btn-cancel-run")
        : getString("btn-clear");
  }

  const runCtrl = body.querySelector(
    "#skimread-cancel",
  ) as HTMLButtonElement | null;
  if (runCtrl) {
    runCtrl.disabled = false; // clears the transient "Pausing…" state
    if (running) {
      runCtrl.textContent = getString("btn-cancel");
      runCtrl.style.display = "";
    } else if (state === "partial") {
      runCtrl.textContent = getString("btn-resume");
      runCtrl.style.display = "";
    } else {
      runCtrl.style.display = "none";
    }
  }
  const saveBtn = body.querySelector(
    "#skimread-save-annotations",
  ) as HTMLButtonElement | null;
  if (saveBtn) {
    const saved =
      state === "complete" && (await hasSavedAnnotations(attachment));
    saveBtn.disabled = state !== "complete" || saved;
    saveBtn.textContent = saved
      ? "Saved as Zotero annotations"
      : "Save as Zotero annotations…";
  }
}

function makeSlider(
  doc: Document,
  label: string,
  pref: "highlightDensity" | "highlightOpacity",
  min: number,
  max: number,
  body: HTMLElement,
) {
  const row = doc.createElement("div");
  row.style.cssText =
    "display:flex;flex-direction:column;gap:2px;font-size:12px;";
  const lab = doc.createElement("span");
  const current = Number(getPref(pref));
  lab.textContent = `${label}: ${current}`;
  const slider = doc.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.value = String(current);
  slider.addEventListener("input", () => {
    lab.textContent = `${label}: ${slider.value}`;
    setPref(pref, Number(slider.value));
  });
  slider.addEventListener("change", () => repaintFromCacheIfAny(body));
  row.append(lab, slider);
  return row;
}

async function refreshStatus(body: HTMLElement) {
  const el = body.querySelector("#skimread-status") as HTMLElement | null;
  if (!el) return;
  const status = await checkStatus();
  if (!status.ok) {
    el.textContent = getString("status-offline");
    el.style.color = "#c0392b";
    return;
  }
  const missing = missingModels(status);
  if (missing.length) {
    el.textContent = getString("status-missing-models", {
      args: { models: missing.join(", ") },
    });
    el.style.color = "#b9770e";
  } else {
    el.textContent = getString("status-ok", {
      args: { version: status.version || "?" },
    });
    el.style.color = "#1e8449";
  }
}
