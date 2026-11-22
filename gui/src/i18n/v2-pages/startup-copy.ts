import type { Locale } from "../locale-meta";
import { startupV2CopyEn } from "../slices/en";
import { startupV2CopyKo } from "../slices/ko";
import { startupV2CopyDe } from "../slices/de";
import { startupV2CopyFr } from "../slices/fr";
import { startupV2CopyZh } from "../slices/zh";
import { startupV2CopyZhTw } from "../slices/zh-TW";
import { startupV2CopyRu } from "../slices/ru";
import { startupV2CopyJa } from "../slices/ja";
import { startupV2CopyTr } from "../slices/tr";
import { startupV2CopyVi } from "../slices/vi";
import { startupV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof startupV2CopyEn, string>> = {
  "en": startupV2CopyEn, "ko": startupV2CopyKo, "de": startupV2CopyDe, "fr": startupV2CopyFr, "zh": startupV2CopyZh, "zh-TW": startupV2CopyZhTw, "ru": startupV2CopyRu, "ja": startupV2CopyJa, "tr": startupV2CopyTr, "vi": startupV2CopyVi, "pt": startupV2CopyPt,
};

export function startupV2Copy(locale: Locale): Record<keyof typeof startupV2CopyEn, string> {
  return BY_LOCALE[locale];
}
