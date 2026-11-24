export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
/**
 * Kimi's regional (kimi.ai) Coding API. Its `/usages` answers a Coding Plan API key the same way
 * the kimi.com origin does (#8332). Only key auth may use it: the probe then calls the origin that
 * already receives this key for inference, so it adds no credential destination. OAuth tokens
 * stay on the kimi.com origin they were issued for.
 */
export const KIMI_CODE_REGIONAL_BASE_URL = "https://api.kimi.ai/coding/v1";
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";

export function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function isCanonicalKimiCodeBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === KIMI_CODE_BASE_URL;
}

export function isCanonicalCommandCodeBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  // OAuth preset points at the API root; the Provider-API preset at /provider/v1.
  return normalized === COMMAND_CODE_BASE_URL || normalized === `${COMMAND_CODE_BASE_URL}/provider/v1`;
}
