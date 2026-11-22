import type { Locale } from "../locale-meta";
import { modelsV2CopyEn } from "../slices/en";
import { modelsV2CopyKo } from "../slices/ko";
import { modelsV2CopyDe } from "../slices/de";
import { modelsV2CopyFr } from "../slices/fr";
import { modelsV2CopyZh } from "../slices/zh";
import { modelsV2CopyZhTw } from "../slices/zh-TW";
import { modelsV2CopyRu } from "../slices/ru";
import { modelsV2CopyJa } from "../slices/ja";
import { modelsV2CopyTr } from "../slices/tr";
import { modelsV2CopyVi } from "../slices/vi";
import { modelsV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof modelsV2CopyEn, string>> = {
  "en": modelsV2CopyEn, "ko": modelsV2CopyKo, "de": modelsV2CopyDe, "fr": modelsV2CopyFr, "zh": modelsV2CopyZh, "zh-TW": modelsV2CopyZhTw, "ru": modelsV2CopyRu, "ja": modelsV2CopyJa, "tr": modelsV2CopyTr, "vi": modelsV2CopyVi, "pt": modelsV2CopyPt,
};

export function modelsV2Copy(locale: Locale): Record<keyof typeof modelsV2CopyEn, string> {
  return BY_LOCALE[locale];
}
