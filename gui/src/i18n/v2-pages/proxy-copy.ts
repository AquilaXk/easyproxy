import type { Locale } from "../locale-meta";
import { proxyV2CopyEn } from "../slices/en";
import { proxyV2CopyKo } from "../slices/ko";
import { proxyV2CopyDe } from "../slices/de";
import { proxyV2CopyFr } from "../slices/fr";
import { proxyV2CopyZh } from "../slices/zh";
import { proxyV2CopyZhTw } from "../slices/zh-TW";
import { proxyV2CopyRu } from "../slices/ru";
import { proxyV2CopyJa } from "../slices/ja";
import { proxyV2CopyTr } from "../slices/tr";
import { proxyV2CopyVi } from "../slices/vi";
import { proxyV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof proxyV2CopyEn, string>> = {
  "en": proxyV2CopyEn, "ko": proxyV2CopyKo, "de": proxyV2CopyDe, "fr": proxyV2CopyFr, "zh": proxyV2CopyZh, "zh-TW": proxyV2CopyZhTw, "ru": proxyV2CopyRu, "ja": proxyV2CopyJa, "tr": proxyV2CopyTr, "vi": proxyV2CopyVi, "pt": proxyV2CopyPt,
};

export function proxyV2Copy(locale: Locale): Record<keyof typeof proxyV2CopyEn, string> {
  return BY_LOCALE[locale];
}
