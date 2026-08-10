export const THEME_IDS = ["notgram-light", "notgram-dark"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ColorScheme = "light" | "dark";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  colorScheme: ColorScheme;
}

export const THEME_DEFINITIONS: Record<ThemeId, ThemeDefinition> = {
  "notgram-light": { id: "notgram-light", label: "浅色", colorScheme: "light" },
  "notgram-dark": { id: "notgram-dark", label: "深色", colorScheme: "dark" },
};

/** The CSS contract every theme must provide. Keep component CSS dependent on these aliases. */
export const THEME_COLOR_TOKENS = [
  "--color-bg-canvas",
  "--color-bg-surface",
  "--color-bg-surface-hover",
  "--color-bg-elevated",
  "--color-bg-control",
  "--color-bg-control-hover",
  "--color-bg-selected",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-disabled",
  "--color-text-on-accent",
  "--color-border-subtle",
  "--color-border-default",
  "--color-border-strong",
  "--color-border-focus",
  "--color-accent",
  "--color-accent-strong",
  "--color-accent-soft",
  "--color-status-success",
  "--color-status-warning",
  "--color-status-danger",
  "--color-status-info",
  "--color-attention-badge",
  "--color-attention-badge-text",
  "--color-text-link",
  "--color-text-code",
  "--color-bg-code",
  "--color-message-incoming",
  "--color-message-outgoing",
  "--color-message-service",
  "--color-qr-background",
  "--color-qr-foreground",
  "--color-bg-media",
  "--color-on-media",
  "--color-overlay",
  "--color-shadow",
  "--color-scrollbar-thumb",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];

export const themeIdForColorTheme = (colorTheme: ColorScheme): ThemeId => (
  colorTheme === "dark" ? "notgram-dark" : "notgram-light"
);

export const colorThemeForThemeId = (themeId: ThemeId): ColorScheme => (
  THEME_DEFINITIONS[themeId].colorScheme
);

export const isThemeId = (value: unknown): value is ThemeId => (
  typeof value === "string" && THEME_IDS.some((themeId) => themeId === value)
);

export const resolveThemeId = (value: unknown, legacyColorTheme?: unknown): ThemeId => {
  if (isThemeId(value)) return value;
  return themeIdForColorTheme(legacyColorTheme === "dark" ? "dark" : "light");
};

export const currentThemeId = (): ThemeId => {
  if (typeof document === "undefined") return "notgram-light";
  const themeId = document.documentElement.dataset.theme;
  return isThemeId(themeId) ? themeId : "notgram-light";
};

export const currentColorTheme = (): ColorScheme => colorThemeForThemeId(currentThemeId());

export const applyThemeToDocument = (themeId: ThemeId) => {
  if (typeof document === "undefined") return;
  const colorScheme = colorThemeForThemeId(themeId);
  document.documentElement.dataset.theme = themeId;
  document.documentElement.style.colorScheme = colorScheme;
};
