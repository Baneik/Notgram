import { readFile } from "node:fs/promises";

const cssPath = new URL("../src/styles/global.css", import.meta.url);
const css = await readFile(cssPath, "utf8");
const failures = [];

for (const match of css.matchAll(/\b(transition|animation)\s*:\s*([^;]+);/g)) {
  const [, kind, declaration] = match;
  const line = css.slice(0, match.index).split(/\r?\n/).length;
  if (declaration.trim() === "none") continue;
  if (!declaration.includes("var(--motion-duration-")) {
    failures.push(`line ${line}: ${kind} must use a shared motion duration token`);
  }
  if (kind === "transition") {
    for (const item of declaration.split(",")) {
      const property = item.trim().split(/\s+/)[0];
      if (property !== "opacity" && property !== "transform") {
        failures.push(`line ${line}: transition animates disallowed property '${property}'`);
      }
    }
  }
}

let keyframeIndex = css.indexOf("@keyframes");
while (keyframeIndex >= 0) {
  const nameMatch = css.slice(keyframeIndex).match(/^@keyframes\s+([\w-]+)/);
  if (!nameMatch) break;
  const blockStart = css.indexOf("{", keyframeIndex + nameMatch[0].length);
  let depth = 1;
  let cursor = blockStart + 1;
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === "{") depth += 1;
    else if (css[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  const body = css.slice(blockStart + 1, cursor - 1);
  const properties = [...body.matchAll(/([\w-]+)\s*:/g)].map((match) => match[1]);
  for (const property of properties) {
    if (property !== "opacity" && property !== "transform") {
      failures.push(`@keyframes ${nameMatch[1]} animates disallowed property '${property}'`);
    }
  }
  keyframeIndex = css.indexOf("@keyframes", cursor);
}

if (failures.length > 0) {
  console.error("Motion contract verification failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Motion contract verified: shared durations and compositor-only properties.");
