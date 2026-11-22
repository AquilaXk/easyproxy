import type { Locale } from "./locale-meta";
import { gatewayClientsCopyEn } from "./slices/en";
import { gatewayClientsCopyKo } from "./slices/ko";
import { gatewayClientsCopyDe } from "./slices/de";
import { gatewayClientsCopyFr } from "./slices/fr";
import { gatewayClientsCopyZh } from "./slices/zh";
import { gatewayClientsCopyZhTw } from "./slices/zh-TW";
import { gatewayClientsCopyRu } from "./slices/ru";
import { gatewayClientsCopyJa } from "./slices/ja";
import { gatewayClientsCopyTr } from "./slices/tr";
import { gatewayClientsCopyVi } from "./slices/vi";
import { gatewayClientsCopyPt } from "./slices/pt";

export type GatewayClientsCopyKey = keyof typeof gatewayClientsCopyEn;

const BY_LOCALE: Record<Locale, Record<keyof typeof gatewayClientsCopyEn, string>> = {
  "en": gatewayClientsCopyEn, "ko": gatewayClientsCopyKo, "de": gatewayClientsCopyDe, "fr": gatewayClientsCopyFr, "zh": gatewayClientsCopyZh, "zh-TW": gatewayClientsCopyZhTw, "ru": gatewayClientsCopyRu, "ja": gatewayClientsCopyJa, "tr": gatewayClientsCopyTr, "vi": gatewayClientsCopyVi, "pt": gatewayClientsCopyPt,
};

export function gatewayClientsCopy(locale: Locale): Record<keyof typeof gatewayClientsCopyEn, string> {
  return BY_LOCALE[locale];
}
