/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_TRANSPORT?: "mock" | "tauri";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
