import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { installPerformanceMonitoring } from "../utils/performanceMonitor";
import { installWebviewGuards } from "../utils/webviewGuards";
import "../styles/themes.css";
import "../styles/global.css";

installWebviewGuards();
installPerformanceMonitoring();

if (isTauri()) {
  void listen("notgram://reload-application", () => globalThis.location.reload());
}

function LocalizedWindow({ render }: { render: () => ReactNode }) {
  useTranslation();
  return render();
}

export const mountWindow = (render: () => ReactNode) => {
  const root = document.getElementById("root");
  if (!root) throw new Error("window root element not found");
  createRoot(root).render(<StrictMode><LocalizedWindow render={render} /></StrictMode>);
};
