import type { Locale } from "./locale-meta";
import { remoteLinkDiagnosticsCopyEn } from "./slices/en";
import { remoteLinkDiagnosticsCopyKo } from "./slices/ko";
import { remoteLinkDiagnosticsCopyDe } from "./slices/de";
import { remoteLinkDiagnosticsCopyFr } from "./slices/fr";
import { remoteLinkDiagnosticsCopyZh } from "./slices/zh";
import { remoteLinkDiagnosticsCopyZhTw } from "./slices/zh-TW";
import { remoteLinkDiagnosticsCopyRu } from "./slices/ru";
import { remoteLinkDiagnosticsCopyJa } from "./slices/ja";
import { remoteLinkDiagnosticsCopyTr } from "./slices/tr";
import { remoteLinkDiagnosticsCopyVi } from "./slices/vi";
import { remoteLinkDiagnosticsCopyPt } from "./slices/pt";

export type RemoteLinkDiagnosticsCopyKey = keyof typeof remoteLinkDiagnosticsCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof remoteLinkDiagnosticsCopyEn, string>> = {
  "en": remoteLinkDiagnosticsCopyEn, "ko": remoteLinkDiagnosticsCopyKo, "de": remoteLinkDiagnosticsCopyDe, "fr": remoteLinkDiagnosticsCopyFr, "zh": remoteLinkDiagnosticsCopyZh, "zh-TW": remoteLinkDiagnosticsCopyZhTw, "ru": remoteLinkDiagnosticsCopyRu, "ja": remoteLinkDiagnosticsCopyJa, "tr": remoteLinkDiagnosticsCopyTr, "vi": remoteLinkDiagnosticsCopyVi, "pt": remoteLinkDiagnosticsCopyPt,
};

export function remoteLinkDiagnosticsCopy(locale: Locale): Record<keyof typeof remoteLinkDiagnosticsCopyEn, string> {
  return BY_LOCALE[locale];
}
