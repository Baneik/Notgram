import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { installPerformanceMonitoring } from "./utils/performanceMonitor";
import { installWebviewGuards } from "./utils/webviewGuards";
import "./styles/global.css";

installWebviewGuards();
installPerformanceMonitoring();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
