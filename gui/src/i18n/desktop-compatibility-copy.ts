import type { Locale } from "./locale-meta";
import { desktopCompatibilityCopyEn } from "./slices/en";
import { desktopCompatibilityCopyKo } from "./slices/ko";
import { desktopCompatibilityCopyDe } from "./slices/de";
import { desktopCompatibilityCopyFr } from "./slices/fr";
import { desktopCompatibilityCopyZh } from "./slices/zh";
import { desktopCompatibilityCopyZhTw } from "./slices/zh-TW";
import { desktopCompatibilityCopyRu } from "./slices/ru";
import { desktopCompatibilityCopyJa } from "./slices/ja";
import { desktopCompatibilityCopyTr } from "./slices/tr";
import { desktopCompatibilityCopyVi } from "./slices/vi";
import { desktopCompatibilityCopyPt } from "./slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof desktopCompatibilityCopyEn, string>> = {
  "en": desktopCompatibilityCopyEn, "ko": desktopCompatibilityCopyKo, "de": desktopCompatibilityCopyDe, "fr": desktopCompatibilityCopyFr, "zh": desktopCompatibilityCopyZh, "zh-TW": desktopCompatibilityCopyZhTw, "ru": desktopCompatibilityCopyRu, "ja": desktopCompatibilityCopyJa, "tr": desktopCompatibilityCopyTr, "vi": desktopCompatibilityCopyVi, "pt": desktopCompatibilityCopyPt,
};

export function desktopCompatibilityCopy(locale: Locale): Record<keyof typeof desktopCompatibilityCopyEn, string> {
  return BY_LOCALE[locale];
}
