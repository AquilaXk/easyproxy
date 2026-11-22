import type { Locale } from "../locale-meta";
import { subagentsV2CopyEn } from "../slices/en";
import { subagentsV2CopyKo } from "../slices/ko";
import { subagentsV2CopyDe } from "../slices/de";
import { subagentsV2CopyFr } from "../slices/fr";
import { subagentsV2CopyZh } from "../slices/zh";
import { subagentsV2CopyZhTw } from "../slices/zh-TW";
import { subagentsV2CopyRu } from "../slices/ru";
import { subagentsV2CopyJa } from "../slices/ja";
import { subagentsV2CopyTr } from "../slices/tr";
import { subagentsV2CopyVi } from "../slices/vi";
import { subagentsV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof subagentsV2CopyEn, string>> = {
  "en": subagentsV2CopyEn, "ko": subagentsV2CopyKo, "de": subagentsV2CopyDe, "fr": subagentsV2CopyFr, "zh": subagentsV2CopyZh, "zh-TW": subagentsV2CopyZhTw, "ru": subagentsV2CopyRu, "ja": subagentsV2CopyJa, "tr": subagentsV2CopyTr, "vi": subagentsV2CopyVi, "pt": subagentsV2CopyPt,
};

export function subagentsV2Copy(locale: Locale): Record<keyof typeof subagentsV2CopyEn, string> {
  return BY_LOCALE[locale];
}
