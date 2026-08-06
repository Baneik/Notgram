import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { App } from "./app/App";
import { SettingsWindow } from "./components/SettingsWindow";
import { VideoWindow } from "./components/VideoWindow";
import { MediaViewerWindow } from "./components/MediaViewerWindow";
import { ContextMenuWindow } from "./components/ContextMenuWindow";
import { WindowChrome } from "./components/WindowChrome";
import { installPerformanceMonitoring } from "./utils/performanceMonitor";
import { installWebviewGuards } from "./utils/webviewGuards";
import "./styles/global.css";

installWebviewGuards();
installPerformanceMonitoring();
if (isTauri()) {
  void listen("notgram://reload-application", () => globalThis.location.reload());
}

const videoWindowId = new URLSearchParams(globalThis.location.search).get("videoWindow");
const mediaViewerWindowId = new URLSearchParams(globalThis.location.search).get("mediaViewerWindow");
const settingsWindow = new URLSearchParams(globalThis.location.search).has("settingsWindow");
const contextMenuWindowId = new URLSearchParams(globalThis.location.search).get("contextMenuWindow");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {contextMenuWindowId ? <ContextMenuWindow id={contextMenuWindowId} /> : mediaViewerWindowId ? <MediaViewerWindow id={mediaViewerWindowId} /> : videoWindowId ? <VideoWindow id={videoWindowId} /> : settingsWindow ? (
      <SettingsWindow />
    ) : (
      <div className="main-window-frame">
        <WindowChrome />
        <div className="main-window-content"><App /></div>
      </div>
    )}
  </StrictMode>,
);
