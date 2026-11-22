import type { Locale } from "../locale-meta";
import { telemetryProfileCopyEn } from "../slices/en";
import { telemetryProfileCopyKo } from "../slices/ko";
import { telemetryProfileCopyDe } from "../slices/de";
import { telemetryProfileCopyFr } from "../slices/fr";
import { telemetryProfileCopyZh } from "../slices/zh";
import { telemetryProfileCopyZhTw } from "../slices/zh-TW";
import { telemetryProfileCopyRu } from "../slices/ru";
import { telemetryProfileCopyJa } from "../slices/ja";
import { telemetryProfileCopyTr } from "../slices/tr";
import { telemetryProfileCopyVi } from "../slices/vi";
import { telemetryProfileCopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof telemetryProfileCopyEn, string>> = {
  "en": telemetryProfileCopyEn, "ko": telemetryProfileCopyKo, "de": telemetryProfileCopyDe, "fr": telemetryProfileCopyFr, "zh": telemetryProfileCopyZh, "zh-TW": telemetryProfileCopyZhTw, "ru": telemetryProfileCopyRu, "ja": telemetryProfileCopyJa, "tr": telemetryProfileCopyTr, "vi": telemetryProfileCopyVi, "pt": telemetryProfileCopyPt,
};

export function telemetryProfileCopy(locale: Locale): Record<keyof typeof telemetryProfileCopyEn, string> {
  return BY_LOCALE[locale];
}
