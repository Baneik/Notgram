import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const htmlEntry = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");

  return {
    plugins: [react()],
    clearScreen: false,
    // Public assets are copied verbatim, so native builds must exclude mock fixtures.
    publicDir: environment.VITE_TELEGRAM_TRANSPORT === "tauri" ? false : "tests/fixtures/public",
    test: {
      include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    },
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/target/**", "**/.native-smoke/**", "**/artifacts/**", "**/vendor/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: {
      target: "es2020",
      minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
      rolldownOptions: {
        input: {
          main: htmlEntry("./index.html"),
          settingsWindow: htmlEntry("./settings-window.html"),
          videoWindow: htmlEntry("./video-window.html"),
          mediaViewerWindow: htmlEntry("./media-viewer-window.html"),
          contextMenuWindow: htmlEntry("./context-menu-window.html"),
          notificationWindow: htmlEntry("./notification-window.html"),
        },
      },
    },
  };
});
