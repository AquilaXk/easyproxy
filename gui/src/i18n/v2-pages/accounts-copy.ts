import type { Locale } from "../locale-meta";
import { accountsV2CopyEn } from "../slices/en";
import { accountsV2CopyKo } from "../slices/ko";
import { accountsV2CopyDe } from "../slices/de";
import { accountsV2CopyFr } from "../slices/fr";
import { accountsV2CopyZh } from "../slices/zh";
import { accountsV2CopyZhTw } from "../slices/zh-TW";
import { accountsV2CopyRu } from "../slices/ru";
import { accountsV2CopyJa } from "../slices/ja";
import { accountsV2CopyTr } from "../slices/tr";
import { accountsV2CopyVi } from "../slices/vi";
import { accountsV2CopyPt } from "../slices/pt";

const BY_LOCALE: Record<Locale, Record<keyof typeof accountsV2CopyEn, string>> = {
  "en": accountsV2CopyEn, "ko": accountsV2CopyKo, "de": accountsV2CopyDe, "fr": accountsV2CopyFr, "zh": accountsV2CopyZh, "zh-TW": accountsV2CopyZhTw, "ru": accountsV2CopyRu, "ja": accountsV2CopyJa, "tr": accountsV2CopyTr, "vi": accountsV2CopyVi, "pt": accountsV2CopyPt,
};

export function accountsV2Copy(locale: Locale): Record<keyof typeof accountsV2CopyEn, string> {
  return BY_LOCALE[locale];
}
