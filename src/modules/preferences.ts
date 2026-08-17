/**
 * Settings pane logic: registers the pref pane, wires the Test connection
 * button and the custom-labels editor (validate & save).
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  checkStatus,
  listAntigravityModels,
  missingModels,
  modelForProvider,
  providerLabel,
} from "../llm/ollama";
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
      out.textContent = getString("status-checking", {
        args: { provider: providerLabel() },
      });
      const status = await checkStatus();
      if (!status.ok) {
        out.textContent = `${providerLabel()} not reachable (${status.error || ""})`;
        return;
      }
      const missing = missingModels(status);
      const configuredModel = modelForProvider("");
      const configuredMissing =
        status.models.length > 0 &&
        configuredModel.length > 0 &&
        !status.models.includes(configuredModel);
      out.textContent =
        getString("status-ok", {
          args: {
            provider: providerLabel(),
            version: status.version || "?",
          },
        }) +
        (missing.length
          ? " — " +
            getString("status-missing-models", {
              args: { models: missing.join(", ") },
            }) +
            ` — ollama pull ${missing[0]}`
          : configuredMissing
            ? ` — selected model “${configuredModel}” is unavailable; refresh the model list`
            : status.models.length
              ? ` — ${status.models.length} models available${
                  configuredModel ? `; selected: ${configuredModel}` : ""
                }`
              : "");
    });
  }

  // --- Provider selector: OpenAI-compatible (HTTP) or a subscription CLI.
  const sel = $("apiType") as (HTMLElement & { value: string }) | null;
  if (sel) {
    const current = String(getPref("apiType") || "openai-compatible");
    sel.value =
      current === "codex-app-server" ||
      current === "claude-code" ||
      current === "antigravity-cli"
        ? current
        : "openai-compatible";

    const set = (id: string, show: boolean) => {
      const el = $(id) as HTMLElement | null;
      if (el) el.style.display = show ? "flex" : "none";
    };

    const refresh = () => {
      const http = sel.value === "openai-compatible";
      const codex = sel.value === "codex-app-server";
      const claude = sel.value === "claude-code";
      const antigravity = sel.value === "antigravity-cli";
      set("url-row", http);
      set("compat-key-row", http);
      set("skim-model-row", http);
      set("num-ctx-row", http);
      set("ollama-ctx-row", http);
      // Consent covers the CLI logins and any remote OpenAI-compatible endpoint;
      // localhost never triggers the consent check at request time.
      set("consent-row", true);
      set("cloud-settings", codex || claude || antigravity);
      set("codex-settings", codex);
      set("claude-settings", claude);
      set("antigravity-settings", antigravity);
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

  // --- select binding ---
  // The `preference` attribute does not bind these elements in this pane (the
  // provider menulist above is wired by hand for the same reason), so a select
  // left to it silently neither loads its stored value nor saves a change.
  /** Append a XUL menuitem to a menulist's popup. */
  const addMenuItem = (list: Element, value: string, label: string) => {
    if (list.localName === "select") {
      const option = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      option.value = value;
      option.textContent = label;
      list.appendChild(option);
      return option;
    }
    const popup =
      list.querySelector("menupopup") ??
      list.appendChild(
        (
          doc as unknown as { createXULElement(t: string): Element }
        ).createXULElement("menupopup"),
      );
    const item = (
      doc as unknown as { createXULElement(t: string): Element }
    ).createXULElement("menuitem");
    item.setAttribute("value", value);
    item.setAttribute("label", label);
    popup.appendChild(item);
    return item;
  };

  const bindSelect = (
    id: string,
    pref:
      | "claudeModel"
      | "codexModel"
      | "antigravityModel"
      | "codexReasoning"
      | "annotationLabelDestination",
    fallback: string,
  ) => {
    const el = $(id) as (Element & { value: string }) | null;
    if (!el) return null;
    const stored = String(getPref(pref) || fallback);
    // Keep a stored value that is not among the offered options (a full model
    // ID, or one from a newer CLI) selectable instead of silently rewriting it.
    const values = (
      Array.from(el.querySelectorAll("menuitem, option")) as Element[]
    ).map((m) => m.getAttribute("value"));
    if (!values.includes(stored)) addMenuItem(el, stored, stored);
    el.value = stored;
    const save = () => setPref(pref, el.value);
    // XUL menulists emit `command`; `change` is kept as a harmless fallback.
    el.addEventListener("command", save);
    el.addEventListener("change", save);
    return el;
  };

  bindSelect("claudeModel", "claudeModel", "sonnet");
  bindSelect("codexReasoning", "codexReasoning", "medium");
  bindSelect(
    "annotationLabelDestination",
    "annotationLabelDestination",
    "comment",
  );
  const commentPrefix = $("annotationCommentPrefix") as
    | (Element & { checked: boolean })
    | null;
  if (commentPrefix) {
    commentPrefix.checked = getPref("annotationCommentPrefix") === true;
    const savePrefix = () =>
      setPref("annotationCommentPrefix", commentPrefix.checked);
    commentPrefix.addEventListener("command", savePrefix);
    commentPrefix.addEventListener("change", savePrefix);
  }
  const codexModelSel = bindSelect("codexModel", "codexModel", "gpt-5.6-luna");
  const antigravityModelSel = bindSelect(
    "antigravityModel",
    "antigravityModel",
    "gemini-3.7-flash-low",
  );

  // Subscription CLIs expose their current model catalog, so use what the
  // installed version actually reports instead of keeping a hardcoded list.
  const wireCliModelRefresh = (
    modelSelect: Element & { value: string },
    button: HTMLButtonElement,
    name: string,
  ) => {
    button.addEventListener("click", async () => {
      const out = $("test-result") as HTMLElement | null;
      if (out) {
        out.textContent = getString("status-checking", {
          args: { provider: name },
        });
      }
      const status =
        name === "Antigravity"
          ? await listAntigravityModels()
          : await checkStatus();
      if (!status.ok || !status.models.length) {
        if (out) {
          out.textContent = `Could not list ${name} models${
            status.error ? ` (${status.error})` : ""
          }`;
        }
        return;
      }
      const current = modelSelect.value;
      const popup = modelSelect.querySelector("menupopup");
      if (popup) {
        while (popup.lastChild) popup.removeChild(popup.lastChild);
      } else modelSelect.textContent = "";
      for (const model of status.models) {
        addMenuItem(modelSelect, model, model);
      }
      // Preserve the current choice when the server still offers it.
      const selected = status.models.includes(current)
        ? current
        : status.models[0];
      modelSelect.value = selected;
      modelSelect.setAttribute("value", selected);
      setPref(name === "Codex" ? "codexModel" : "antigravityModel", selected);
      if (out) out.textContent = `${status.models.length} ${name} models`;
    });
  };
  const codexRefresh = $("codex-refresh-models") as HTMLButtonElement | null;
  if (codexModelSel && codexRefresh) {
    wireCliModelRefresh(codexModelSel, codexRefresh, "Codex");
  }
  const antigravityRefresh = $(
    "antigravity-refresh-models",
  ) as HTMLButtonElement | null;
  if (antigravityModelSel && antigravityRefresh) {
    wireCliModelRefresh(antigravityModelSel, antigravityRefresh, "Antigravity");
  }

  // --- model picker: populate the datalist from the server's models ---
  const populateModels = async () => {
    if (sel?.value !== "openai-compatible") return;
    const list = $("model-list") as HTMLElement | null;
    if (!list) return;
    const result = $("test-result") as HTMLElement | null;
    if (result) {
      result.textContent = getString("status-checking", {
        args: { provider: providerLabel() },
      });
    }
    const status = await checkStatus();
    list.textContent = "";
    for (const model of status.models) {
      const opt = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      opt.value = model;
      list.appendChild(opt);
    }
    if (result) {
      result.textContent = status.ok
        ? `${status.models.length} models available`
        : `${providerLabel()} not reachable`;
    }
  };
  const refreshModelsBtn = $("refresh-models") as HTMLButtonElement | null;
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener("click", () => void populateModels());
  }
  // Populate once on open so the model fields offer a dropdown immediately.
  void populateModels();

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
