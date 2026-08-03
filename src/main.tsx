import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { VideoWindow } from "./components/VideoWindow";
import { installPerformanceMonitoring } from "./utils/performanceMonitor";
import { installWebviewGuards } from "./utils/webviewGuards";
import "./styles/global.css";

installWebviewGuards();
installPerformanceMonitoring();

const videoWindowId = new URLSearchParams(globalThis.location.search).get("videoWindow");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {videoWindowId ? <VideoWindow id={videoWindowId} /> : <App />}
  </StrictMode>,
);
