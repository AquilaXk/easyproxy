import type { Locale } from "../locale-meta";
import { connectV2CopyEn } from "../slices/en";
import { connectV2CopyKo } from "../slices/ko";
import { connectV2CopyDe } from "../slices/de";
import { connectV2CopyFr } from "../slices/fr";
import { connectV2CopyZh } from "../slices/zh";
import { connectV2CopyZhTw } from "../slices/zh-TW";
import { connectV2CopyRu } from "../slices/ru";
import { connectV2CopyJa } from "../slices/ja";
import { connectV2CopyTr } from "../slices/tr";
import { connectV2CopyVi } from "../slices/vi";
import { connectV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof connectV2CopyEn, string>> = {
  "en": connectV2CopyEn, "ko": connectV2CopyKo, "de": connectV2CopyDe, "fr": connectV2CopyFr, "zh": connectV2CopyZh, "zh-TW": connectV2CopyZhTw, "ru": connectV2CopyRu, "ja": connectV2CopyJa, "tr": connectV2CopyTr, "vi": connectV2CopyVi, "pt": connectV2CopyPt,
};

export function connectV2Copy(locale: Locale): Record<keyof typeof connectV2CopyEn, string> {
  return BY_LOCALE[locale];
}
