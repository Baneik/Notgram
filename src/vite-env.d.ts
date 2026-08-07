/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_TRANSPORT?: "mock" | "tauri";
  readonly VITE_WEBVIEW_STRESS?: "1";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
