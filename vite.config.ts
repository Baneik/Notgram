import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const htmlEntry = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**", "**/.native-smoke/**"],
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
});
