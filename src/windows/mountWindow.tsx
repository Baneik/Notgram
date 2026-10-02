import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { installPerformanceMonitoring } from "../utils/performanceMonitor";
import { installWebviewGuards } from "../utils/webviewGuards";
import emojiFontLicense from "../assets/fonts/noto-color-emoji/OFL.txt?url&no-inline";
import "../styles/themes.css";
import "../styles/global.css";

installWebviewGuards();
installPerformanceMonitoring();

const fontLicense = document.createElement("link");
fontLicense.rel = "license";
fontLicense.href = emojiFontLicense;
fontLicense.title = "Noto Color Emoji — SIL Open Font License 1.1";
document.head.append(fontLicense);

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
  // Measure message geometry only after the bundled emoji font is available.
  void document.fonts.load('14px "Noto Color Emoji"', "😀").catch(() => undefined).then(() => {
    createRoot(root).render(<StrictMode><LocalizedWindow render={render} /></StrictMode>);
  });
};
