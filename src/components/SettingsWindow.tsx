import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useTelegramStore } from "../store/telegramStore";
import { SettingsDialog } from "./SettingsDialog";

export function SettingsWindow() {
  const initialize = useTelegramStore((state) => state.initialize);

  useEffect(() => {
    void initialize({ settingsOnly: true });
  }, [initialize]);

  return <SettingsDialog standalone onClose={() => void getCurrentWindow().close()} />;
}
