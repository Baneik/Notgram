import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");
const themeSource = readText("src/theme/theme.ts");
const paletteSource = readText("src/styles/themes.css");
const componentSource = readText("src/styles/global.css");

const contractBody = themeSource.match(/THEME_COLOR_TOKENS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1];
if (!contractBody) throw new Error("Unable to read THEME_COLOR_TOKENS from src/theme/theme.ts.");

const contractTokens = [...contractBody.matchAll(/"(--color-[a-z0-9-]+)"/g)].map((match) => match[1]);
if (contractTokens.length === 0 || new Set(contractTokens).size !== contractTokens.length) {
  throw new Error("The theme token contract is empty or contains duplicate entries.");
}

function extractFirstBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  const openIndex = source.indexOf("{", markerIndex);
  if (markerIndex < 0 || openIndex < 0) throw new Error(`Missing theme block for ${marker}.`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  throw new Error(`Unclosed theme block for ${marker}.`);
}

function tokensDeclaredIn(block) {
  return [...block.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
}

function assertSameContract(themeId, declarations) {
  const declared = new Set(declarations);
  const missing = contractTokens.filter((token) => !declared.has(token));
  const extra = [...declared].filter((token) => !contractTokens.includes(token));
  const duplicates = declarations.filter((token, index) => declarations.indexOf(token) !== index);
  if (missing.length || extra.length || duplicates.length) {
    throw new Error([
      `${themeId} does not satisfy the theme contract.`,
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      extra.length ? `Extra: ${extra.join(", ")}` : "",
      duplicates.length ? `Duplicate: ${[...new Set(duplicates)].join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
}

assertSameContract(
  "notgram-light",
  tokensDeclaredIn(extractFirstBlock(paletteSource, '[data-theme="notgram-light"]')),
);
assertSameContract(
  "notgram-dark",
  tokensDeclaredIn(extractFirstBlock(paletteSource, '[data-theme="notgram-dark"]')),
);

const knownTokens = new Set(contractTokens);
const usedTokens = [...componentSource.matchAll(/var\((--color-[a-z0-9-]+)/g)].map((match) => match[1]);
const unknownTokens = [...new Set(usedTokens.filter((token) => !knownTokens.has(token)))];
if (unknownTokens.length) {
  throw new Error(`Component CSS uses undeclared theme tokens: ${unknownTokens.join(", ")}`);
}

const componentContractSource = componentSource.split("@media (forced-colors: none)")[0];
const rawLightSurfaces = componentContractSource
  .split(/\r?\n/)
  .map((line, index) => ({ line: index + 1, text: line.trim() }))
  .filter(({ text }) => /background(?:-color)?\s*:\s*#[ef][0-9a-f]{5}\b/i.test(text));
if (rawLightSurfaces.length) {
  const locations = rawLightSurfaces.map(({ line, text }) => `${line}: ${text}`).join("\n");
  throw new Error(`Component CSS contains hard-coded light surfaces; use a semantic token instead.\n${locations}`);
}

console.log(`Theme contract is valid (${contractTokens.length} semantic color tokens).`);
