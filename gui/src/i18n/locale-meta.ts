import type { TKey } from "./en";

export type Locale =
  | "en"
  | "zh"
  | "zh-TW"
  | "ko"
  | "fr"
  | "de"
  | "vi"
  | "pt"
  | "ru"
  | "ja"
  | "tr";

export type { TKey };

export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  "zh-TW": "繁體中文",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  vi: "Tiếng Việt",
  pt: "Português",
  ru: "Русский",
  ja: "日本語",
  tr: "Türkçe",
};

export function localeDisplayName(locale: Locale): string {
  return LOCALE_NATIVE_NAMES[locale];
}
