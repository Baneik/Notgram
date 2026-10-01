import { build, preview } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repository = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.resolve(process.env.NOTGRAM_BENCHMARK_ROOT ?? repository);
const directory = path.join(sourceRoot, "artifacts", "session-switch-production");
const output = path.join(directory, "dist");
if (!output.startsWith(path.join(sourceRoot, "artifacts") + path.sep)) throw new Error("Invalid benchmark output directory");
await mkdir(directory, { recursive: true });
const entry = path.join(directory, "index.html");
const relativeImport = file => "./" + path.relative(directory, file).replaceAll(path.sep, "/");
await writeFile(entry, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module">
import { MockTelegramTransport } from ${JSON.stringify(relativeImport(path.join(sourceRoot, "src/telegram/mockTransport.ts")))};
import { installSessionSwitchFixture } from ${JSON.stringify(relativeImport(path.join(repository, "tests/e2e/fixtures/sessionSwitchFixture.ts")))};
installSessionSwitchFixture(MockTelegramTransport);
void import(${JSON.stringify(relativeImport(path.join(sourceRoot, "src/main.tsx")))});
</script></body></html>`);
process.env.VITE_TELEGRAM_TRANSPORT = "mock";
await build({ root: sourceRoot, configFile: path.join(sourceRoot, "vite.config.ts"),
  build: { outDir: output, emptyOutDir: true, rolldownOptions: { input: { benchmark: entry } } } });
const server = await preview({ root: sourceRoot, configFile: path.join(sourceRoot, "vite.config.ts"),
  build: { outDir: output }, preview: { host: "127.0.0.1", port: 1422, strictPort: true } });
try {
  const status = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(repository, "node_modules/playwright/cli.js"), "test",
      "tests/e2e/session-switch-performance.e2e.ts", ...process.argv.slice(2)], {
      cwd: repository, stdio: "inherit", windowsHide: true,
      env: { ...process.env, NOTGRAM_E2E_EXTERNAL_SERVER: "1", NOTGRAM_PRODUCTION_SWITCH_TEST: "1",
        NOTGRAM_SWITCH_BENCHMARK_PATH: "/artifacts/session-switch-production/index.html" },
    });
    child.once("error", error => { console.error(error); resolve(1); });
    child.once("exit", code => resolve(code ?? 1));
  });
  process.exitCode = status;
} finally { await new Promise(resolve => server.httpServer.close(resolve)); }
