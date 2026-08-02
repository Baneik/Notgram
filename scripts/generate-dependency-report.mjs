import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("Usage: node scripts/generate-dependency-report.mjs --output <path>");
}
const outputPath = resolve(repositoryRoot, process.argv[outputIndex + 1]);

const packageLock = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));
const npmDependencies = Object.entries(packageLock.packages)
  .filter(([packagePath]) => packagePath !== "")
  .map(([packagePath, entry]) => ({
    name: packagePath.split("node_modules/").at(-1),
    version: entry.version,
    license: entry.license ?? null,
    developmentOnly: entry.dev === true,
    optional: entry.optional === true,
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const cargoResult = spawnSync(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--format-version",
    "1",
    "--locked",
    "--filter-platform",
    "x86_64-pc-windows-msvc",
  ],
  { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (cargoResult.status !== 0) {
  const reason = cargoResult.error?.message || cargoResult.stderr.trim() || "unknown error";
  throw new Error(`cargo metadata failed: ${reason}`);
}
const cargoMetadata = JSON.parse(cargoResult.stdout);
const resolvedCargoPackages = new Set(cargoMetadata.resolve.nodes.map((node) => node.id));
const cargoDependencies = cargoMetadata.packages
  .filter((dependency) => dependency.name !== "notgram" && resolvedCargoPackages.has(dependency.id))
  .map((dependency) => ({
    name: dependency.name,
    version: dependency.version,
    license: dependency.license ?? null,
    source: dependency.source?.replace(/^registry\+/, "") ?? null,
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const report = {
  schemaVersion: 1,
  generatedFrom: {
    npm: "package-lock.json",
    cargo: "src-tauri/Cargo.lock",
  },
  npm: npmDependencies,
  cargo: cargoDependencies,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Dependency report written with ${npmDependencies.length} npm and ${cargoDependencies.length} Cargo packages.`);
