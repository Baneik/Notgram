import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const readText = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");
const versionSource = JSON.parse(readText("version.json"));
const version = versionSource.version;

if (typeof version !== "string" || !semverPattern.test(version)) {
  throw new Error(`version.json contains an invalid semantic version: ${String(version)}`);
}

const changes = [];

function updateJson(relativePath, update) {
  const currentText = readText(relativePath);
  const newline = currentText.includes("\r\n") ? "\r\n" : "\n";
  const data = JSON.parse(currentText);
  update(data);
  const nextText = `${JSON.stringify(data, null, 2).replaceAll("\n", newline)}${newline}`;

  if (nextText !== currentText) {
    changes.push({ relativePath, nextText });
  }
}

function updatePackageSection(relativePath) {
  const currentText = readText(relativePath);
  const sectionStart = currentText.search(/^\[package\][ \t]*\r?$/m);
  if (sectionStart < 0) {
    throw new Error(`${relativePath} does not contain a [package] section.`);
  }

  const sectionBodyStart = currentText.indexOf("\n", sectionStart) + 1;
  const nextSectionOffset = currentText.slice(sectionBodyStart).search(/^\[/m);
  const sectionEnd = nextSectionOffset < 0 ? currentText.length : sectionBodyStart + nextSectionOffset;
  const section = currentText.slice(sectionBodyStart, sectionEnd);
  const packageVersionPattern = /^version[ \t]*=[ \t]*"([^"]+)"[ \t]*(\r?)$/gm;
  const matches = [...section.matchAll(packageVersionPattern)];
  if (matches.length !== 1) {
    throw new Error(`${relativePath} must contain exactly one package version.`);
  }

  const nextSection = section.replace(
    packageVersionPattern,
    (_match, _currentVersion, carriageReturn) => `version = "${version}"${carriageReturn}`,
  );
  const nextText = `${currentText.slice(0, sectionBodyStart)}${nextSection}${currentText.slice(sectionEnd)}`;
  if (nextText !== currentText) {
    changes.push({ relativePath, nextText });
  }
}

function updateCargoLock(relativePath) {
  const currentText = readText(relativePath);
  const packageBlocks = currentText.split(/(?=^\[\[package\]\][ \t]*\r?$)/m);
  const matchingIndexes = packageBlocks
    .map((block, index) => (/^name[ \t]*=[ \t]*"notgram"[ \t]*\r?$/m.test(block) ? index : -1))
    .filter((index) => index >= 0);

  if (matchingIndexes.length !== 1) {
    throw new Error(`${relativePath} must contain exactly one notgram package entry.`);
  }

  const index = matchingIndexes[0];
  const packageVersionPattern = /^version[ \t]*=[ \t]*"([^"]+)"[ \t]*(\r?)$/gm;
  packageBlocks[index] = packageBlocks[index].replace(
    packageVersionPattern,
    (_match, _currentVersion, carriageReturn) => `version = "${version}"${carriageReturn}`,
  );
  const nextText = packageBlocks.join("");
  if (nextText !== currentText) {
    changes.push({ relativePath, nextText });
  }
}

updateJson("package.json", (data) => {
  data.version = version;
});
updateJson("package-lock.json", (data) => {
  data.version = version;
  data.packages[""].version = version;
});
updateJson("src-tauri/tauri.conf.json", (data) => {
  data.version = version;
});
updatePackageSection("src-tauri/Cargo.toml");
updateCargoLock("src-tauri/Cargo.lock");

if (checkOnly && changes.length > 0) {
  console.error(`Version ${version} is not synchronized:`);
  for (const change of changes) {
    console.error(`- ${change.relativePath}`);
  }
  console.error("Run npm run version:sync and commit the result.");
  process.exitCode = 1;
} else if (changes.length > 0) {
  for (const change of changes) {
    writeFileSync(resolve(repositoryRoot, change.relativePath), change.nextText, "utf8");
  }
  console.log(`Synchronized version ${version} across ${changes.length} files.`);
} else {
  console.log(`Version ${version} is synchronized.`);
}
