import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const protectedTokenPattern = /NG(?:SEP|LINE|VALUE)|8D31/;
const allowedLiteralKeys = new Set(["关闭", "1 天", "1 周", "1 个月"]);
const nativeLanguageNames = new Set(["简体中文", "日本語"]);
const dynamicTranslationKeys = new Set(allowedLiteralKeys);
const sourceKeys = new Set();
const problems = [];

const sourceFiles = [];
const collectSourceFiles = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath !== path.join(sourceRoot, "i18n")) collectSourceFiles(fullPath);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (entry.name === "mockData.ts" || entry.name === "mockTransport.ts") continue;
    sourceFiles.push(fullPath);
  }
};

const childNodes = (node) => {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "leadingComments", "innerComments", "trailingComments"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") children.push(item);
    } else if (value && typeof value.type === "string") {
      children.push(value);
    }
  }
  return children;
};

const locationFor = (filePath, node) =>
  `${path.relative(root, filePath)}:${node.loc?.start.line ?? 1}:${node.loc?.start.column ?? 0}`;

const isNonDisplayKey = (node, parent) =>
  parent?.type === "ObjectProperty" && parent.key === node && !parent.computed;

collectSourceFiles(sourceRoot);

for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", ...(filePath.endsWith(".tsx") ? ["jsx"] : [])],
  });

  const visit = (node, ancestors = []) => {
    const parent = ancestors.at(-1);
    const isTranslationCallee = (candidate) => candidate?.type === "Identifier" &&
      (candidate.name === "translate" || candidate.name === "t");
    const isTranslateCall = node.type === "CallExpression" &&
      isTranslationCallee(node.callee);

    if (isTranslateCall) {
      const keyNode = node.arguments[0];
      if (keyNode?.type === "StringLiteral") {
        sourceKeys.add(keyNode.value);
      } else {
        const allowedPresetCall = path.basename(filePath) === "ConversationOverlays.tsx" &&
          keyNode?.type === "Identifier" && keyNode.name === "label";
        if (!allowedPresetCall) {
          problems.push(`${locationFor(filePath, node)} uses a dynamic translation key`);
        }
      }
    }

    if (node.type === "StringLiteral" && cjkPattern.test(node.value)) {
      const isTranslationKey = parent?.type === "CallExpression" &&
        isTranslationCallee(parent.callee) &&
        parent.arguments[0] === node;
      const isPresetKey = path.basename(filePath) === "ConversationOverlays.tsx" &&
        allowedLiteralKeys.has(node.value);
      const isNativeLanguageName = path.basename(filePath) === "SettingsDialog.tsx" &&
        nativeLanguageNames.has(node.value);
      if (!isTranslationKey && !isNonDisplayKey(node, parent) &&
          !isPresetKey && !isNativeLanguageName &&
          parent?.type !== "TSLiteralType") {
        problems.push(`${locationFor(filePath, node)} contains untranslated text ${JSON.stringify(node.value)}`);
      }
    }

    if (node.type === "TemplateLiteral") {
      const text = node.quasis.map((part) => part.value.cooked ?? "").join("");
      if (cjkPattern.test(text)) {
        problems.push(`${locationFor(filePath, node)} contains an untranslated template literal`);
      }
    }

    if (node.type === "JSXText" && cjkPattern.test(node.value)) {
      const text = node.value.replace(/\s+/g, " ").trim();
      if (text && !nativeLanguageNames.has(text)) {
        problems.push(`${locationFor(filePath, node)} contains untranslated JSX text ${JSON.stringify(text)}`);
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const child of childNodes(node)) visit(child, nextAncestors);
  };

  visit(ast.program);
}

for (const key of dynamicTranslationKeys) sourceKeys.add(key);

const readLocale = (fileName) => {
  const source = fs.readFileSync(path.join(sourceRoot, "i18n", "locales", fileName), "utf8");
  const assignment = source.indexOf(" = ");
  return JSON.parse(source.slice(source.indexOf("{", assignment), source.lastIndexOf("}") + 1));
};

const locales = { en: readLocale("en.ts"), ja: readLocale("ja.ts") };
const placeholders = (value) => [...value.matchAll(/\{\{[A-Za-z0-9_]+\}\}/g)]
  .map((match) => match[0]).sort();

for (const [localeName, locale] of Object.entries(locales)) {
  const localeKeys = new Set(Object.keys(locale));
  for (const key of sourceKeys) {
    if (!localeKeys.has(key)) problems.push(`${localeName} is missing ${JSON.stringify(key)}`);
  }
  for (const key of localeKeys) {
    if (!sourceKeys.has(key)) problems.push(`${localeName} has unused key ${JSON.stringify(key)}`);
  }
  for (const [key, value] of Object.entries(locale)) {
    if (typeof value !== "string" || value.length === 0) {
      problems.push(`${localeName} has an empty translation for ${JSON.stringify(key)}`);
      continue;
    }
    if (protectedTokenPattern.test(value)) {
      problems.push(`${localeName} leaked a protected token in ${JSON.stringify(key)}`);
    }
    if (placeholders(key).join("|") !== placeholders(value).join("|")) {
      problems.push(`${localeName} changed placeholders in ${JSON.stringify(key)}`);
    }
    if (localeName === "en" && cjkPattern.test(value)) {
      problems.push(`en contains untranslated CJK text in ${JSON.stringify(key)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n verification failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`i18n verification passed (${sourceKeys.size} keys across zh-CN, en and ja)`);
}
