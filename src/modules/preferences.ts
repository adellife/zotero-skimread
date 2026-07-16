/**
 * Settings pane logic: registers the pref pane, wires the Test connection
 * button and the custom-labels editor (validate & save).
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { checkStatus, missingModels, providerLabel } from "../llm/ollama";
import { getPref, setPref } from "../utils/prefs";
import { parseCustomLabels } from "../prompts/skim";

export function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

export function onPrefsLoad(window: Window) {
  const doc = window.document;
  const $ = (id: string) =>
    doc.querySelector(`#zotero-prefpane-${config.addonRef}-${id}`);

  // --- test connection ---
  const btn = $("test") as HTMLButtonElement | null;
  const out = $("test-result") as HTMLElement | null;
  if (btn && out) {
    btn.addEventListener("click", async () => {
      out.textContent = getString("status-checking");
      const status = await checkStatus();
      if (!status.ok) {
        out.textContent = `${providerLabel()} not reachable (${status.error || ""})`;
        return;
      }
      const missing = missingModels(status);
      out.textContent =
        getString("status-ok", { args: { version: status.version || "?" } }) +
        (missing.length
          ? " — " +
            getString("status-missing-models", {
              args: { models: missing.join(", ") },
            }) +
            ` — ollama pull ${missing[0]}`
          : status.models.length
            ? ` — ${status.models.join(", ")}`
            : "");
    });
  }

  // --- API type selector ---
  const sel = $("apiType") as (HTMLElement & { value: string }) | null;
  if (sel) {
    sel.value = String(getPref("apiType") || "ollama");
    const updateProviderFields = () => {
      const cloud =
        sel.value === "openai-api" ||
        sel.value === "anthropic" ||
        sel.value === "codex-app-server";
      const cloudSettings = $("cloud-settings") as HTMLElement | null;
      const openAIKey = $("openai-key-row") as HTMLElement | null;
      const anthropicKey = $("anthropic-key-row") as HTMLElement | null;
      const codexSettings = $("codex-settings") as HTMLElement | null;
      if (cloudSettings) cloudSettings.style.display = cloud ? "flex" : "none";
      if (openAIKey)
        openAIKey.style.display = sel.value === "openai-api" ? "flex" : "none";
      if (anthropicKey)
        anthropicKey.style.display =
          sel.value === "anthropic" ? "flex" : "none";
      if (codexSettings)
        codexSettings.style.display =
          sel.value === "codex-app-server" ? "flex" : "none";
    };
    updateProviderFields();
    const saveProvider = () => {
      setPref("apiType", sel.value);
      updateProviderFields();
    };
    // Native XUL menulists emit `command`; HTML selects emit `change`.
    sel.addEventListener("command", saveProvider);
    sel.addEventListener("change", saveProvider);
  }

  // --- custom labels editor ---
  const area = $("customLabels") as HTMLTextAreaElement | null;
  const save = $("saveLabels") as HTMLButtonElement | null;
  const labelsOut = $("labels-result") as HTMLElement | null;
  if (area && save && labelsOut) {
    try {
      const current = String(getPref("customLabels") || "[]");
      area.value = JSON.stringify(JSON.parse(current), null, 2);
    } catch {
      area.value = String(getPref("customLabels") || "[]");
    }
    save.addEventListener("click", () => {
      const parsed = parseCustomLabels(area.value);
      if (!parsed) {
        labelsOut.textContent = getString("labels-invalid");
        labelsOut.style.color = "#c0392b";
        return;
      }
      setPref("customLabels", JSON.stringify(parsed));
      area.value = JSON.stringify(parsed, null, 2);
      labelsOut.textContent = getString("labels-saved", {
        args: { count: parsed.length },
      });
      labelsOut.style.color = "#1e8449";
    });
  }
}
