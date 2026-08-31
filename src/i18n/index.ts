import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { ja } from "./locales/ja";
import { zhCN } from "./locales/zh-CN";
import {
  DEFAULT_LANGUAGE,
  detectSystemLanguage,
  resolveLanguage,
  supportedLanguageFor,
  type LanguagePreference,
  type SupportedLanguage,
} from "./language";

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: detectSystemLanguage(),
  fallbackLng: "en",
  supportedLngs: ["zh-CN", "en", "ja"],
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

let activePreference: LanguagePreference = "system";

export const applyLanguagePreference = (preference: LanguagePreference) => {
  activePreference = preference;
  const language = resolveLanguage(preference);
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
    document.documentElement.dataset.languagePreference = preference;
  }
  if (i18n.resolvedLanguage !== language) void i18n.changeLanguage(language);
};

export const translate = (
  key: string,
  values?: Record<string, unknown>,
): string => i18n.t(key, values);

export const currentLanguage = (): SupportedLanguage =>
  supportedLanguageFor(i18n.resolvedLanguage ?? i18n.language ?? "") ?? DEFAULT_LANGUAGE;

if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (activePreference === "system") applyLanguagePreference("system");
  });
}

export { i18n };
export * from "./language";
