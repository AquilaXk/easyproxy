import type { Locale } from "./locale-meta";
import { modelsOverallCopyEn } from "./slices/en";
import { modelsOverallCopyKo } from "./slices/ko";
import { modelsOverallCopyDe } from "./slices/de";
import { modelsOverallCopyFr } from "./slices/fr";
import { modelsOverallCopyZh } from "./slices/zh";
import { modelsOverallCopyZhTw } from "./slices/zh-TW";
import { modelsOverallCopyRu } from "./slices/ru";
import { modelsOverallCopyJa } from "./slices/ja";
import { modelsOverallCopyTr } from "./slices/tr";
import { modelsOverallCopyVi } from "./slices/vi";
import { modelsOverallCopyPt } from "./slices/pt";

export type ModelsOverallCopyKey = keyof typeof modelsOverallCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof modelsOverallCopyEn, string>> = {
  "en": modelsOverallCopyEn, "ko": modelsOverallCopyKo, "de": modelsOverallCopyDe, "fr": modelsOverallCopyFr, "zh": modelsOverallCopyZh, "zh-TW": modelsOverallCopyZhTw, "ru": modelsOverallCopyRu, "ja": modelsOverallCopyJa, "tr": modelsOverallCopyTr, "vi": modelsOverallCopyVi, "pt": modelsOverallCopyPt,
};

export function modelsOverallCopy(locale: Locale): Record<keyof typeof modelsOverallCopyEn, string> {
  return BY_LOCALE[locale];
}
