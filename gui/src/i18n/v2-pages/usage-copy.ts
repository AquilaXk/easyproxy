import type { Locale } from "../locale-meta";
import { usageV2CopyEn } from "../slices/en";
import { usageV2CopyKo } from "../slices/ko";
import { usageV2CopyDe } from "../slices/de";
import { usageV2CopyFr } from "../slices/fr";
import { usageV2CopyZh } from "../slices/zh";
import { usageV2CopyZhTw } from "../slices/zh-TW";
import { usageV2CopyRu } from "../slices/ru";
import { usageV2CopyJa } from "../slices/ja";
import { usageV2CopyTr } from "../slices/tr";
import { usageV2CopyVi } from "../slices/vi";
import { usageV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof usageV2CopyEn, string>> = {
  "en": usageV2CopyEn, "ko": usageV2CopyKo, "de": usageV2CopyDe, "fr": usageV2CopyFr, "zh": usageV2CopyZh, "zh-TW": usageV2CopyZhTw, "ru": usageV2CopyRu, "ja": usageV2CopyJa, "tr": usageV2CopyTr, "vi": usageV2CopyVi, "pt": usageV2CopyPt,
};

export function usageV2Copy(locale: Locale): Record<keyof typeof usageV2CopyEn, string> {
  return BY_LOCALE[locale];
}
