import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerPrefsPane, onPrefsLoad } from "./modules/preferences";
import {
  registerReaderSection,
  unwatchProviderPrefs,
} from "./modules/readerSection";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPrefsPane();
  registerReaderSection();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unwatchProviderPrefs();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  // M1+: watch for attachment adds to queue background processing
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      onPrefsLoad(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
