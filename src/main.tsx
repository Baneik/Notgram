import { App } from "./app/App";
import { WindowChrome } from "./components/WindowChrome";
import { prepareNativeContextMenuWindow } from "./contextMenu/nativeContextMenuBridge";
import { mountWindow } from "./windows/mountWindow";
import { telegramStore } from "./store/telegramStore";
import { startSettingsBackupSync } from "./backup/backupRuntime";

const stopSettingsBackupSync = startSettingsBackupSync();
if (import.meta.hot) import.meta.hot.dispose(stopSettingsBackupSync);

const unregisterMemoryCaches = telegramStore.getState().registerMemoryCaches();
if (import.meta.hot) import.meta.hot.dispose(unregisterMemoryCaches);

void prepareNativeContextMenuWindow().catch(() => undefined);

mountWindow(() => (
  <div className="main-window-frame">
    <WindowChrome />
    <div className="main-window-content"><App /></div>
  </div>
));
