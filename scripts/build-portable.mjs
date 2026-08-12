import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const environmentPath = resolve(repositoryRoot, ".env");
const publisherPath = resolve(repositoryRoot, "scripts", "publish-portable.ps1");
const artifactsRoot = resolve(repositoryRoot, "artifacts", "portable");

if (process.platform !== "win32") {
  throw new Error("Portable builds currently require Windows.");
}
if (!existsSync(environmentPath)) {
  throw new Error(`Local environment file is missing: ${environmentPath}`);
}

const localEnvironment = parseEnv(readFileSync(environmentPath, "utf8"));
const buildEnvironment = { ...process.env, ...localEnvironment };
for (const name of Object.keys(buildEnvironment)) {
  if (name.toLowerCase() === "psmodulepath") {
    delete buildEnvironment[name];
  }
}
const commitResult = spawnSync("git.exe", ["-C", repositoryRoot, "rev-parse", "--short=8", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
});
if (commitResult.status !== 0) {
  throw new Error(commitResult.stderr?.trim() || "Unable to resolve the current Git commit.");
}

const now = new Date();
const pad = (value, width = 2) => String(value).padStart(width, "0");
const timestamp = [
  now.getFullYear(),
  pad(now.getMonth() + 1),
  pad(now.getDate()),
  "-",
  pad(now.getHours()),
  pad(now.getMinutes()),
  pad(now.getSeconds()),
  "-",
  pad(now.getMilliseconds(), 3),
].join("");
const commit = commitResult.stdout.trim();
let destinationRoot = resolve(artifactsRoot, `${timestamp}-${commit}`);
let collision = 1;
while (existsSync(destinationRoot)) {
  destinationRoot = resolve(artifactsRoot, `${timestamp}-${commit}-${collision}`);
  collision += 1;
}

console.log(`Building portable artifact from ${environmentPath}`);
console.log(`Artifact directory: ${destinationRoot}`);

const result = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    publisherPath,
    "-DestinationRoot",
    destinationRoot,
    "-SkipChecks",
    "-AllowDirty",
  ],
  {
    cwd: repositoryRoot,
    env: buildEnvironment,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
