import type { Locale } from "../locale-meta";
import { logsV2CopyEn } from "../slices/en";
import { logsV2CopyKo } from "../slices/ko";
import { logsV2CopyDe } from "../slices/de";
import { logsV2CopyFr } from "../slices/fr";
import { logsV2CopyZh } from "../slices/zh";
import { logsV2CopyZhTw } from "../slices/zh-TW";
import { logsV2CopyRu } from "../slices/ru";
import { logsV2CopyJa } from "../slices/ja";
import { logsV2CopyTr } from "../slices/tr";
import { logsV2CopyVi } from "../slices/vi";
import { logsV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof logsV2CopyEn, string>> = {
  "en": logsV2CopyEn, "ko": logsV2CopyKo, "de": logsV2CopyDe, "fr": logsV2CopyFr, "zh": logsV2CopyZh, "zh-TW": logsV2CopyZhTw, "ru": logsV2CopyRu, "ja": logsV2CopyJa, "tr": logsV2CopyTr, "vi": logsV2CopyVi, "pt": logsV2CopyPt,
};

export function logsV2Copy(locale: Locale): Record<keyof typeof logsV2CopyEn, string> {
  return BY_LOCALE[locale];
}
