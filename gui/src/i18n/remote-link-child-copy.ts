import type { Locale } from "./locale-meta";
import { remoteLinkChildCopyEn } from "./slices/en";
import { remoteLinkChildCopyKo } from "./slices/ko";
import { remoteLinkChildCopyDe } from "./slices/de";
import { remoteLinkChildCopyFr } from "./slices/fr";
import { remoteLinkChildCopyZh } from "./slices/zh";
import { remoteLinkChildCopyZhTw } from "./slices/zh-TW";
import { remoteLinkChildCopyRu } from "./slices/ru";
import { remoteLinkChildCopyJa } from "./slices/ja";
import { remoteLinkChildCopyTr } from "./slices/tr";
import { remoteLinkChildCopyVi } from "./slices/vi";
import { remoteLinkChildCopyPt } from "./slices/pt";

export type RemoteLinkChildCopyKey = keyof typeof remoteLinkChildCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof remoteLinkChildCopyEn, string>> = {
  "en": remoteLinkChildCopyEn, "ko": remoteLinkChildCopyKo, "de": remoteLinkChildCopyDe, "fr": remoteLinkChildCopyFr, "zh": remoteLinkChildCopyZh, "zh-TW": remoteLinkChildCopyZhTw, "ru": remoteLinkChildCopyRu, "ja": remoteLinkChildCopyJa, "tr": remoteLinkChildCopyTr, "vi": remoteLinkChildCopyVi, "pt": remoteLinkChildCopyPt,
};

export function remoteLinkChildCopy(locale: Locale): Record<keyof typeof remoteLinkChildCopyEn, string> {
  return BY_LOCALE[locale];
}
