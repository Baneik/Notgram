export const SUPPORTED_LANGUAGES = ["zh-CN", "en", "ja"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = "system" | SupportedLanguage;

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export const isLanguagePreference = (value: unknown): value is LanguagePreference =>
  value === "system" || SUPPORTED_LANGUAGES.some((language) => language === value);

export const supportedLanguageFor = (languageTag: string): SupportedLanguage | undefined => {
  const normalized = languageTag.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return undefined;
};

export const systemLanguageCandidates = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
};

export const detectSystemLanguage = (
  languageTags: readonly string[] = systemLanguageCandidates(),
): SupportedLanguage => {
  for (const languageTag of languageTags) {
    const supported = supportedLanguageFor(languageTag);
    if (supported) return supported;
  }
  return DEFAULT_LANGUAGE;
};

export const resolveLanguage = (
  preference: LanguagePreference,
  languageTags?: readonly string[],
): SupportedLanguage => preference === "system"
  ? detectSystemLanguage(languageTags)
  : preference;
