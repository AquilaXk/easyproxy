import type { Locale } from "./locale-meta";
import { accountProbeCopyEn } from "./slices/en";
import { accountProbeCopyKo } from "./slices/ko";
import { accountProbeCopyDe } from "./slices/de";
import { accountProbeCopyFr } from "./slices/fr";
import { accountProbeCopyZh } from "./slices/zh";
import { accountProbeCopyZhTw } from "./slices/zh-TW";
import { accountProbeCopyRu } from "./slices/ru";
import { accountProbeCopyJa } from "./slices/ja";
import { accountProbeCopyTr } from "./slices/tr";
import { accountProbeCopyVi } from "./slices/vi";
import { accountProbeCopyPt } from "./slices/pt";

export type AccountProbeCopyKey = keyof typeof accountProbeCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof accountProbeCopyEn, string>> = {
  "en": accountProbeCopyEn, "ko": accountProbeCopyKo, "de": accountProbeCopyDe, "fr": accountProbeCopyFr, "zh": accountProbeCopyZh, "zh-TW": accountProbeCopyZhTw, "ru": accountProbeCopyRu, "ja": accountProbeCopyJa, "tr": accountProbeCopyTr, "vi": accountProbeCopyVi, "pt": accountProbeCopyPt,
};

export function accountProbeCopy(locale: Locale): Record<keyof typeof accountProbeCopyEn, string> {
  return BY_LOCALE[locale];
}
