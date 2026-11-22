import type { Locale } from "./locale-meta";
import { gettingStartedCopyEn } from "./slices/en";
import { gettingStartedCopyKo } from "./slices/ko";
import { gettingStartedCopyDe } from "./slices/de";
import { gettingStartedCopyFr } from "./slices/fr";
import { gettingStartedCopyZh } from "./slices/zh";
import { gettingStartedCopyZhTw } from "./slices/zh-TW";
import { gettingStartedCopyRu } from "./slices/ru";
import { gettingStartedCopyJa } from "./slices/ja";
import { gettingStartedCopyTr } from "./slices/tr";
import { gettingStartedCopyVi } from "./slices/vi";
import { gettingStartedCopyPt } from "./slices/pt";

export type GettingStartedKey = keyof typeof gettingStartedCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof gettingStartedCopyEn, string>> = {
  "en": gettingStartedCopyEn, "ko": gettingStartedCopyKo, "de": gettingStartedCopyDe, "fr": gettingStartedCopyFr, "zh": gettingStartedCopyZh, "zh-TW": gettingStartedCopyZhTw, "ru": gettingStartedCopyRu, "ja": gettingStartedCopyJa, "tr": gettingStartedCopyTr, "vi": gettingStartedCopyVi, "pt": gettingStartedCopyPt,
};

export function gettingStartedCopy(locale: Locale): Record<keyof typeof gettingStartedCopyEn, string> {
  return BY_LOCALE[locale];
}
