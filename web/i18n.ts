import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

export type SupportedLanguage = "system" | "ja" | "en";

// Resolve a settings.language value to an actual i18n language code. "system"
// means "let the LanguageDetector pick from navigator.language / cached value",
// expressed by passing undefined to changeLanguage().
export function resolveLanguage(
  setting: SupportedLanguage,
): string | undefined {
  if (setting === "ja" || setting === "en") return setting;
  return undefined;
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
    fallbackLng: "en",
    supportedLngs: ["en", "ja"],
    interpolation: { escapeValue: false },
    detection: {
      // Honor user's explicit choice first; otherwise navigator.language.
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "pd-i18n-detected",
      caches: ["localStorage"],
    },
  });

export default i18n;
