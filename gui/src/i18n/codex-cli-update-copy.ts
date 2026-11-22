import type { Locale } from "./locale-meta";
import { codexCliUpdateCopyEn } from "./slices/en";
import { codexCliUpdateCopyKo } from "./slices/ko";
import { codexCliUpdateCopyDe } from "./slices/de";
import { codexCliUpdateCopyFr } from "./slices/fr";
import { codexCliUpdateCopyZh } from "./slices/zh";
import { codexCliUpdateCopyZhTw } from "./slices/zh-TW";
import { codexCliUpdateCopyRu } from "./slices/ru";
import { codexCliUpdateCopyJa } from "./slices/ja";
import { codexCliUpdateCopyTr } from "./slices/tr";
import { codexCliUpdateCopyVi } from "./slices/vi";
import { codexCliUpdateCopyPt } from "./slices/pt";

export type CodexCliUpdateCopyKey = keyof typeof codexCliUpdateCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof codexCliUpdateCopyEn, string>> = {
  "en": codexCliUpdateCopyEn, "ko": codexCliUpdateCopyKo, "de": codexCliUpdateCopyDe, "fr": codexCliUpdateCopyFr, "zh": codexCliUpdateCopyZh, "zh-TW": codexCliUpdateCopyZhTw, "ru": codexCliUpdateCopyRu, "ja": codexCliUpdateCopyJa, "tr": codexCliUpdateCopyTr, "vi": codexCliUpdateCopyVi, "pt": codexCliUpdateCopyPt,
};

export function codexCliUpdateCopy(locale: Locale): Record<keyof typeof codexCliUpdateCopyEn, string> {
  return BY_LOCALE[locale];
}
