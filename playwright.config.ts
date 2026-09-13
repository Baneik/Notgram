import { defineConfig, devices } from "@playwright/test";

const usesExternalServer = process.env.NOTGRAM_E2E_EXTERNAL_SERVER === "1";
const suite = process.env.NOTGRAM_E2E_SUITE ?? "all";
const diagnostics = process.env.NOTGRAM_E2E_DIAGNOSTICS === "1";
if (!["all", "regression", "smoke", "visual", "performance"].includes(suite)) {
  throw new Error(`Unknown E2E suite: ${suite}`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /\.e2e\.ts/,
  grep: suite === "smoke" ? /@smoke/ : suite === "visual" ? /@visual/ : suite === "performance" ? /@performance/ : undefined,
  grepInvert: suite === "regression" ? /@visual|@performance/ : undefined,
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{-projectName}{-platform}{ext}",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1422",
    headless: true,
    locale: "zh-CN",
    trace: diagnostics ? "on" : process.env.CI ? "on-first-retry" : "off",
    screenshot: diagnostics ? "on" : "only-on-failure",
    launchOptions: { args: ["--mute-audio"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: usesExternalServer ? undefined : {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1422",
    url: "http://127.0.0.1:1422",
    reuseExistingServer: false,
    env: { VITE_TELEGRAM_TRANSPORT: "mock" },
  },
});
