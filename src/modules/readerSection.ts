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
import { getReaderForTab } from "../reader/adapter";
import {
  cacheState,
  clearHighlights,
  getCachedLabels,
  getConfiguredLabels,
  getLabelMode,
  hasCachedRun,
  hasSavedAnnotations,
  isRunning,
  runSkim,
  saveSkimAsAnnotations,
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
    paneID: "localreader-panel",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("reader-section-head"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("reader-section-sidenav"),
      icon: "chrome://zotero/skin/20/universal/highlight.svg",
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
  status.id = "localreader-status";
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
  select.id = "localreader-mode";
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

  // action buttons
  const btnRow = doc.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;";
  const genBtn = doc.createElement("button");
  genBtn.id = "localreader-generate";
  genBtn.textContent = getString("btn-generate");
  genBtn.style.cssText = "font-size:12px;padding:3px 10px;";
  const cancelBtn = doc.createElement("button");
  cancelBtn.id = "localreader-cancel";
  cancelBtn.textContent = getString("btn-cancel");
  cancelBtn.style.cssText = "font-size:12px;padding:3px 10px;display:none;";
  const clearBtn = doc.createElement("button");
  clearBtn.id = "localreader-clear";
  clearBtn.textContent = getString("btn-clear");
  clearBtn.style.cssText = "font-size:12px;padding:3px 10px;";
  btnRow.append(genBtn, cancelBtn, clearBtn);
  wrap.append(btnRow);

  const saveBtn = doc.createElement("button");
  saveBtn.id = "localreader-save-annotations";
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

  const progress = doc.createElement("div");
  progress.id = "localreader-progress";
  progress.style.cssText = "font-size:11px;opacity:0.8;min-height:14px;";
  wrap.append(progress);

  genBtn.addEventListener("click", () => onGenerate(body));
  cancelBtn.addEventListener("click", () => {
    const { tabID } = currentContext(body);
    if (tabID) clearHighlights(tabID); // sets cancelled; partial cache survives
    setProgress(body, getString("progress-cancelling"));
  });
  clearBtn.addEventListener("click", () => {
    const { tabID } = currentContext(body);
    if (tabID) clearHighlights(tabID);
    setProgress(body, getString("progress-cleared"));
    void refreshButtons(body);
  });
  saveBtn.addEventListener("click", () => {
    void onSaveAnnotations(body);
  });

  // dynamic label rows
  const labelBox = doc.createElement("div");
  labelBox.id = "localreader-labels";
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

  body.append(wrap);
}

/**
 * Render per-label toggle rows. `labels` explicit (post-run), else cached
 * labels for this document, else configured labels; in auto mode with no
 * cache yet, show a hint instead.
 */
async function renderLabelRows(body: HTMLElement, labels: LabelDef[] | null) {
  const box = body.querySelector("#localreader-labels") as HTMLElement | null;
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
    count.id = `localreader-count-${l.key}`;
    count.style.cssText = "opacity:0.6;";
    row.append(cb, dot, doc.createTextNode(l.name), count);
    box.append(row);
  }
}

function setProgress(body: HTMLElement, msg: string) {
  const el = body.querySelector("#localreader-progress") as HTMLElement | null;
  if (el) el.textContent = msg;
}

function setCounts(body: HTMLElement, counts: Record<string, number>) {
  for (const [key, n] of Object.entries(counts)) {
    const el = body.querySelector(
      `#localreader-count-${key}`,
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
  };
}

async function onGenerate(body: HTMLElement) {
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
    "#localreader-generate",
  ) as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#localreader-cancel",
  ) as HTMLElement | null;
  // resume partial runs instead of wiping them; full regenerate only when complete
  const regenerate = (await cacheState(attachment)) === "complete";
  if (genBtn) genBtn.disabled = true;
  if (cancelBtn) cancelBtn.style.display = "";
  await runSkim(reader, tabID, attachment, callbacks(body), regenerate);
  if (genBtn) genBtn.disabled = false;
  if (cancelBtn) cancelBtn.style.display = "none";
  await refreshButtons(body);
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
      "Save the currently visible Local Reader highlights as standard Zotero annotations? You can then use Zotero’s Add Note from Annotations command.",
    )
  ) {
    return;
  }
  const saveBtn = body.querySelector(
    "#localreader-save-annotations",
  ) as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  setProgress(body, "Saving Zotero annotations…");
  try {
    const result = await saveSkimAsAnnotations(reader, attachment);
    setProgress(
      body,
      result.alreadySaved
        ? `${result.saved} Zotero annotations already saved.`
        : `Saved ${result.saved} Zotero annotations.`,
    );
  } catch (error) {
    setProgress(body, `⚠ ${String((error as Error).message || error)}`);
  } finally {
    await refreshButtons(body);
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

/** Switch Generate label to "Reset & regenerate" when a cached run exists. */
async function refreshButtons(body: HTMLElement) {
  const { attachment } = currentContext(body);
  const genBtn = body.querySelector(
    "#localreader-generate",
  ) as HTMLButtonElement | null;
  if (!genBtn || !attachment) return;
  const state = await cacheState(attachment);
  genBtn.textContent =
    state === "complete"
      ? getString("btn-regenerate")
      : state === "partial"
        ? getString("btn-resume")
        : getString("btn-generate");
  const saveBtn = body.querySelector(
    "#localreader-save-annotations",
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
  const el = body.querySelector("#localreader-status") as HTMLElement | null;
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
