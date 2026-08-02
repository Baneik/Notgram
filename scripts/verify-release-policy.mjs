import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const version = readJson("version.json").version;
const policy = readJson("release-policy.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  const match = typeof value === "string" ? value.match(semverPattern) : undefined;
  if (!match) throw new Error(`Invalid release policy version: ${String(value)}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

parseVersion(version);
if (policy.schemaVersion !== 1) throw new Error("Unsupported release policy schema.");
if (compareVersions(policy.minimumCompatibleVersion, version) > 0) {
  throw new Error("The minimum compatible version cannot exceed the release version.");
}
if (!Number.isInteger(policy.cacheSchemaVersion) || policy.cacheSchemaVersion < 1) {
  throw new Error("The cache schema version must be a positive integer.");
}
const cacheVersion = readText("src/store/telegramStore.cache.ts")
  .match(/TELEGRAM_CACHE_VERSION\s*=\s*(\d+)/)?.[1];
if (Number(cacheVersion) !== policy.cacheSchemaVersion) {
  throw new Error("The release policy cache schema does not match the application cache version.");
}
if (policy.channels?.stable?.acceptPrerelease !== false ||
    policy.channels?.candidate?.acceptPrerelease !== true ||
    policy.channels?.candidate?.acceptStable !== true ||
    policy.channels.stable.manifest === policy.channels.candidate.manifest) {
  throw new Error("Stable and candidate update channel policies are invalid.");
}
if (policy.rollback?.strategy !== "forward-only" ||
    policy.rollback?.allowDowngrades !== false ||
    !Number.isInteger(policy.rollback?.retainedSignedVersions) ||
    policy.rollback.retainedSignedVersions < 2) {
  throw new Error("Rollback policy must be forward-only and retain at least two signed releases.");
}
if (tauri.bundle?.windows?.allowDowngrades !== false) {
  throw new Error("Tauri Windows bundles must reject downgrades.");
}
if (tauri.bundle?.windows?.nsis?.installMode !== "currentUser") {
  throw new Error("NSIS releases must use the current-user installation scope.");
}
if (policy.dataLifecycle?.storage !== "os-user-profile" ||
    policy.dataLifecycle?.portableStorage !== "os-user-profile" ||
    policy.dataLifecycle?.retainOnPortableReplacement !== true ||
    policy.dataLifecycle?.retainOnUpgrade !== true ||
    policy.dataLifecycle?.retainOnUninstall !== true ||
    policy.dataLifecycle?.cleanup !== "explicit-user-action") {
  throw new Error("Release data lifecycle policy is invalid.");
}
console.log(`Release policy is valid for ${version}.`);
