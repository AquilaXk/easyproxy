import type { Locale } from "./locale-meta";
import type { GettingStartedKey } from "./getting-started-copy";
import { shellV2CopyEn } from "./slices/en";
import { shellV2CopyKo } from "./slices/ko";
import { shellV2CopyDe } from "./slices/de";
import { shellV2CopyFr } from "./slices/fr";
import { shellV2CopyZh } from "./slices/zh";
import { shellV2CopyZhTw } from "./slices/zh-TW";
import { shellV2CopyRu } from "./slices/ru";
import { shellV2CopyJa } from "./slices/ja";
import { shellV2CopyTr } from "./slices/tr";
import { shellV2CopyVi } from "./slices/vi";
import { shellV2CopyPt } from "./slices/pt";

export type ShellV2Key = Exclude<keyof typeof shellV2CopyEn, GettingStartedKey>;

const BY_LOCALE: Record<Locale, Record<keyof typeof shellV2CopyEn, string>> = {
  "en": shellV2CopyEn, "ko": shellV2CopyKo, "de": shellV2CopyDe, "fr": shellV2CopyFr, "zh": shellV2CopyZh, "zh-TW": shellV2CopyZhTw, "ru": shellV2CopyRu, "ja": shellV2CopyJa, "tr": shellV2CopyTr, "vi": shellV2CopyVi, "pt": shellV2CopyPt,
};

export function shellV2Copy(locale: Locale): Record<keyof typeof shellV2CopyEn, string> {
  return BY_LOCALE[locale];
}
