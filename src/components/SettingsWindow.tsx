import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useTelegramStore } from "../store/telegramStore";
import { SettingsDialog } from "./SettingsDialog";
import { WindowChrome } from "./WindowChrome";

export function SettingsWindow() {
  const initialize = useTelegramStore((state) => state.initialize);

  useEffect(() => {
    void initialize({ settingsOnly: true });
  }, [initialize]);

  return (
    <div className="settings-window-frame">
      <WindowChrome />
      <div className="settings-window-content">
        <SettingsDialog standalone onClose={() => void getCurrentWindow().close()} />
      </div>
    </div>
  );
}
