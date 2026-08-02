import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /\.e2e\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1422",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--mute-audio"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1422",
    url: "http://127.0.0.1:1422",
    reuseExistingServer: false,
    env: { VITE_TELEGRAM_TRANSPORT: "mock" },
  },
});
