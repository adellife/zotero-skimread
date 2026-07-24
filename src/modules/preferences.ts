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
    image: `chrome://${config.addonRef}/content/icons/skimread-icon.png`,
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

  // --- Provider selector: one flat list, with only the relevant fields shown.
  const sel = $("apiType") as (HTMLElement & { value: string }) | null;
  if (sel) {
    sel.value = String(getPref("apiType") || "ollama");

    // Which field rows each provider needs.
    const usesUrl = new Set(["ollama", "openai-compatible"]);
    const usesLocalModels = new Set([
      "ollama",
      "openai-compatible",
      "openai-api",
      "anthropic",
    ]);
    const usesNumCtx = new Set(["ollama"]);
    const isCloud = new Set([
      "openai-api",
      "anthropic",
      "codex-app-server",
      "claude-code",
    ]);

    const set = (id: string, show: boolean) => {
      const el = $(id) as HTMLElement | null;
      if (el) el.style.display = show ? "flex" : "none";
    };

    const refresh = () => {
      const p = sel.value;
      set("url-row", usesUrl.has(p));
      set("compat-key-row", p === "openai-compatible");
      set("skim-model-row", usesLocalModels.has(p));
      set("tldr-model-row", usesLocalModels.has(p));
      set("num-ctx-row", usesNumCtx.has(p));
      // Consent is required for any provider that can send text off-machine —
      // the cloud APIs, the CLI logins, and a remote OpenAI-compatible server.
      set("consent-row", isCloud.has(p) || p === "openai-compatible");
      set("cloud-settings", isCloud.has(p));
      set("openai-key-row", p === "openai-api");
      set("anthropic-key-row", p === "anthropic");
      set("codex-settings", p === "codex-app-server");
      set("claude-settings", p === "claude-code");
    };

    const save = () => {
      setPref("apiType", sel.value);
      refresh();
    };

    refresh();
    // Native XUL menulists emit `command`; HTML selects emit `change`.
    sel.addEventListener("command", save);
    sel.addEventListener("change", save);
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
