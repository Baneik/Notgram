let snapshotStyleSheet: CSSStyleSheet | undefined;

export const getConversationSnapshotStyleSheet = () => {
  if (snapshotStyleSheet) return snapshotStyleSheet;
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      rules.push(...Array.from(sheet.cssRules, (rule) => rule.cssText));
    } catch {
      // Application styles are same-origin; inaccessible extension styles are irrelevant.
    }
  }
  snapshotStyleSheet = new CSSStyleSheet();
  snapshotStyleSheet.replaceSync(rules.join("\n"));
  return snapshotStyleSheet;
};
