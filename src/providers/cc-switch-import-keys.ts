/**
 * Opt-in live API-key detection and bounded extraction for GUI CC-Switch import.
 *
 * Security & privacy boundary:
 * - Never imported or called by the keyless CLI importer (`runCcSwitchProviderImport`).
 * - Preview mode (`extractApiKeys: false`) validates non-empty secret candidates strictly in
 *   byte buffers and returns only `hasApiKey: boolean`, never decoding secret bytes into JS strings.
 * - Apply mode (`extractApiKeys: true`) runs only after explicit user consent (`consent: true`),
 *   validates byte length (1..4096), UTF-8, single-line printable/no-control-char bounds, rejects
 *   credential-reference markers (`keychain:`, `gcp-sa:`, `${...}`, `$VAR`), decodes only the
 *   single winning candidate per provider row, and zeroes every transient buffer in `finally`.
 */
import {
  MAX_CODEX_TOML_BYTES,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  encodeCodePointUtf8,
  equalsAsciiBytes,
  matchKnownJsonKeyBytes,
  parseHex4Bytes,
  unescapeJsonStringBytesBounded,
  unescapeTomlStringBytes,
  validateJsonPrimitiveBytes,
  validateUtf8AndJsonStringBounds,
} from "./cc-switch-import-bytes";

export const MAX_CC_SWITCH_API_KEY_BYTES = 4096;

export type CcSwitchSecretPlacement = "key" | "anthropic-bearer" | "anthropic-x-api-key";

export interface CcSwitchSecretInspection {
  hasApiKey: boolean;
  apiKey?: string;
  placement?: CcSwitchSecretPlacement;
}

const PREFIX_KEYCHAIN = Buffer.from("keychain:", "ascii");
const PREFIX_GCP_SA = Buffer.from("gcp-sa:", "ascii");

function toLowerAsciiByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 32 : b;
}

function startsWithAsciiCaseInsensitive(slice: Uint8Array, prefix: Uint8Array): boolean {
  if (slice.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (toLowerAsciiByte(slice[i]!) !== prefix[i]!) return false;
  }
  return true;
}

export function isValidUtf8Bytes(slice: Uint8Array): boolean {
  let i = 0;
  while (i < slice.length) {
    const b0 = slice[i]!;
    if (b0 < 0x80) {
      i++;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= slice.length) return false;
      const b1 = slice[i + 1]!;
      if ((b1 & 0xc0) !== 0x80) return false;
      i += 2;
      continue;
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= slice.length) return false;
      const b1 = slice[i + 1]!;
      const b2 = slice[i + 2]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return false;
      if (b0 === 0xe0 && b1 < 0xa0) return false;
      if (b0 === 0xed && b1 >= 0xa0) return false;
      i += 3;
      continue;
    }
    if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 >= slice.length) return false;
      const b1 = slice[i + 1]!;
      const b2 = slice[i + 2]!;
      const b3 = slice[i + 3]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return false;
      if (b0 === 0xf0 && b1 < 0x90) return false;
      if (b0 === 0xf4 && b1 > 0x8f) return false;
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Byte-level validation for imported API keys.
 * Returns trimmed bounds `{ start, end }` inside `raw` or `null` if invalid/disallowed.
 */
export function validateCcSwitchApiKeyBytes(raw: Uint8Array): { start: number; end: number } | null {
  let start = 0;
  let end = raw.length;
  while (start < end && (raw[start] === 0x20 || raw[start] === 0x09)) start++;
  while (end > start && (raw[end - 1] === 0x20 || raw[end - 1] === 0x09)) end--;
  const len = end - start;
  if (len <= 0 || len > MAX_CC_SWITCH_API_KEY_BYTES) return null;
  const trimmed = raw.subarray(start, end);
  for (let i = 0; i < len; i++) {
    const b = trimmed[i]!;
    if (b <= 0x20 || b === 0x7f) return null;
  }
  if (!isValidUtf8Bytes(trimmed)) return null;
  // Refuse internal reference markers, env expansions, JSON blobs, and refusal sentinels.
  if (trimmed[0] === 0x24 /* '$' */ || trimmed[0] === 0x7b /* '{' */) return null;
  for (let i = 0; i + 1 < len; i++) {
    if (trimmed[i] === 0x24 && trimmed[i + 1] === 0x7b /* '${' */) return null;
  }
  if (startsWithAsciiCaseInsensitive(trimmed, PREFIX_KEYCHAIN)) return null;
  if (startsWithAsciiCaseInsensitive(trimmed, PREFIX_GCP_SA)) return null;
  if (equalsAsciiBytes(trimmed, METADATA_REFUSED_SENTINEL) || equalsAsciiBytes(trimmed, URL_SYNTAX_REFUSED_SENTINEL)) {
    return null;
  }
  return { start, end };
}

type SecretSlotName =
  | "envAnthropicApiKey"
  | "envAnthropicAuthToken"
  | "envOpenAiApiKey"
  | "envGeminiApiKey"
  | "envGoogleApiKey"
  | "envApiKey"
  | "authOpenAiApiKey"
  | "authAnthropicApiKey"
  | "authAnthropicAuthToken"
  | "authGeminiApiKey"
  | "authGoogleApiKey"
  | "authApiKey"
  | "authToken"
  | "authBearer"
  | "optionsApiKey"
  | "topOpenAiApiKey"
  | "topAnthropicApiKey"
  | "topAnthropicAuthToken"
  | "topGeminiApiKey"
  | "topGoogleApiKey"
  | "topApiKey"
  | "topAuthToken"
  | "topToken"
  | "topKey"
  | "tomlKey";

function copyValidatedSecretBytes(raw: Uint8Array): Uint8Array | null {
  const bounds = validateCcSwitchApiKeyBytes(raw);
  if (!bounds) return null;
  const copy = new Uint8Array(bounds.end - bounds.start);
  copy.set(raw.subarray(bounds.start, bounds.end));
  return copy;
}

function unescapeJsonTomlBytesBounded(
  bytes: Uint8Array,
  bounds: { start: number; end: number },
): Uint8Array | null {
  if (bounds.end - bounds.start > MAX_CODEX_TOML_BYTES) return null;
  const out = new Uint8Array(bounds.end - bounds.start);
  let r = bounds.start;
  let w = 0;
  let ok = false;
  try {
    while (r < bounds.end) {
      const b = bytes[r]!;
      if (b !== 0x5c) {
        out[w++] = b;
        r++;
        continue;
      }
      r++;
      if (r >= bounds.end) return null;
      const esc = bytes[r]!;
      r++;
      if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[w++] = esc;
      else if (esc === 0x6e) out[w++] = 0x0a;
      else if (esc === 0x72) out[w++] = 0x0d;
      else if (esc === 0x74) out[w++] = 0x09;
      else if (esc === 0x62) out[w++] = 0x08;
      else if (esc === 0x66) out[w++] = 0x0c;
      else if (esc === 0x75) {
        let cp = parseHex4Bytes(bytes.subarray(0, bounds.end), r);
        if (cp < 0) return null;
        r += 4;
        if (cp >= 0xd800 && cp <= 0xdbff) {
          if (r + 6 > bounds.end || bytes[r] !== 0x5c || bytes[r + 1] !== 0x75) return null;
          const low = parseHex4Bytes(bytes.subarray(0, bounds.end), r + 2);
          if (low < 0xdc00 || low > 0xdfff) return null;
          r += 6;
          cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        } else if (cp >= 0xdc00 && cp <= 0xdfff) {
          return null;
        }
        w += encodeCodePointUtf8(cp, out, w);
      } else {
        return null;
      }
    }
    const result = new Uint8Array(w);
    result.set(out.subarray(0, w));
    ok = true;
    return result;
  } finally {
    out.fill(0);
    if (!ok) {
      // Nothing returned on failure.
    }
  }
}

function findTomlQuotedEnd(slice: Uint8Array, quoteStart: number): number {
  const q = slice[quoteStart]!;
  if (q !== 0x22 && q !== 0x27) return -1;
  if (quoteStart + 2 < slice.length && slice[quoteStart + 1] === q && slice[quoteStart + 2] === q) return -1;
  let i = quoteStart + 1;
  while (i < slice.length) {
    const b = slice[i]!;
    if (b < 0x20 || b === 0x7f) return -1;
    if (q === 0x22 && b === 0x5c) {
      i += 2;
      continue;
    }
    if (b === q) return i;
    i++;
  }
  return -1;
}

function tomlBareOrQuotedMatchesAscii(slice: Uint8Array, expected: string): boolean {
  if (slice.length === 0) return false;
  const q = slice[0]!;
  if (q === 0x22 || q === 0x27) {
    const qEnd = findTomlQuotedEnd(slice, 0);
    if (qEnd !== slice.length - 1) return false;
    const unesc = unescapeTomlStringBytes(slice.subarray(1, qEnd), q);
    if (!unesc) return false;
    try {
      return equalsAsciiBytes(unesc, expected);
    } finally {
      unesc.fill(0);
    }
  }
  return equalsAsciiBytes(slice, expected);
}

function encodeTrimmedAsciiHexKey(slice: Uint8Array): string | undefined {
  let s = 0;
  let e = slice.length;
  while (s < e && (slice[s] === 0x20 || slice[s] === 0x09 || slice[s] === 0x0a || slice[s] === 0x0d)) s++;
  while (e > s && (slice[e - 1] === 0x20 || slice[e - 1] === 0x09 || slice[e - 1] === 0x0a || slice[e - 1] === 0x0d)) e--;
  if (s >= e) return undefined;
  const sub = slice.subarray(s, e);
  if (!isValidUtf8Bytes(sub)) return undefined;
  let hex = "";
  for (let i = 0; i < sub.length; i++) {
    hex += sub[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function parseTomlHeaderSection(innerRaw: Uint8Array): { kind: "other" } | { kind: "model_provider"; id: string } {
  let s = 0;
  let e = innerRaw.length;
  while (s < e && (innerRaw[s] === 0x20 || innerRaw[s] === 0x09)) s++;
  while (e > s && (innerRaw[e - 1] === 0x20 || innerRaw[e - 1] === 0x09)) e--;
  const inner = innerRaw.subarray(s, e);
  const dot = inner.indexOf(0x2e);
  if (dot <= 0) return { kind: "other" };
  let firstEnd = dot;
  while (firstEnd > 0 && (inner[firstEnd - 1] === 0x20 || inner[firstEnd - 1] === 0x09)) firstEnd--;
  if (!tomlBareOrQuotedMatchesAscii(inner.subarray(0, firstEnd), "model_providers")) {
    return { kind: "other" };
  }
  let secStart = dot + 1;
  while (secStart < inner.length && (inner[secStart] === 0x20 || inner[secStart] === 0x09)) secStart++;
  const rest = inner.subarray(secStart);
  if (rest.length === 0) return { kind: "other" };
  if (rest[0] === 0x22 || rest[0] === 0x27) {
    const qEnd = findTomlQuotedEnd(rest, 0);
    if (qEnd !== rest.length - 1) return { kind: "other" };
    const unesc = unescapeTomlStringBytes(rest.subarray(1, qEnd), rest[0]!);
    if (!unesc) return { kind: "other" };
    try {
      const hexId = encodeTrimmedAsciiHexKey(unesc);
      return hexId ? { kind: "model_provider", id: hexId } : { kind: "other" };
    } finally {
      unesc.fill(0);
    }
  }
  if (rest.includes(0x2e)) return { kind: "other" };
  const hexId = encodeTrimmedAsciiHexKey(rest);
  return hexId ? { kind: "model_provider", id: hexId } : { kind: "other" };
}

export function inspectCodexTomlSecretBytes(
  bytes: Uint8Array,
  extractKey: boolean,
): { hasApiKey: boolean; keyBytes?: Uint8Array } {
  if (bytes.length > MAX_CODEX_TOML_BYTES) return { hasApiKey: false };
  const ownedBuffers: Uint8Array[] = [];
  let rootKey: Uint8Array | null = null;
  let rootHasKey = false;
  let modelProvider: string | undefined;
  const providerKeys = new Map<string, Uint8Array>();
  const providerHasKey = new Set<string>();
  const seenProviders = new Set<string>();
  let currentSection: { kind: "root" } | { kind: "model_provider"; id: string } | { kind: "other" } = { kind: "root" };
  let lineStart = 0;
  let lineCount = 0;

  try {
    for (let idx = 0; idx <= bytes.length; idx++) {
      if (idx < bytes.length && bytes[idx] !== 0x0a) continue;
      lineCount++;
      if (lineCount > 501) break;
      let lineEnd = idx;
      if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
      const slice = bytes.subarray(lineStart, lineEnd);
      lineStart = idx + 1;

      let p = 0;
      while (p < slice.length && (slice[p] === 0x20 || slice[p] === 0x09)) p++;
      if (p >= slice.length || slice[p] === 0x23) continue;
      if (slice[p] === 0x5b) {
        if (p + 1 < slice.length && slice[p + 1] === 0x5b) {
          currentSection = { kind: "other" };
          continue;
        }
        let closeB = -1;
        let inQ = 0;
        for (let k = p + 1; k < slice.length; k++) {
          const b = slice[k]!;
          if (inQ === 0 && b === 0x23) break;
          if (inQ === 0 && (b === 0x22 || b === 0x27)) { inQ = b; continue; }
          if (inQ === 0x22 && b === 0x5c) { k++; continue; }
          if (inQ !== 0 && b === inQ) { inQ = 0; continue; }
          if (inQ === 0 && b === 0x5d) { closeB = k; break; }
        }
        if (closeB < 0) continue;
        currentSection = parseTomlHeaderSection(slice.subarray(p + 1, closeB));
        if (currentSection.kind === "model_provider") seenProviders.add(currentSection.id);
        continue;
      }

      let eq = -1;
      let inKeyQuote = 0;
      for (let k = p; k < slice.length; k++) {
        const b = slice[k]!;
        if (inKeyQuote === 0 && b === 0x23) break;
        if (inKeyQuote === 0 && (b === 0x22 || b === 0x27)) { inKeyQuote = b; continue; }
        if (inKeyQuote === 0x22 && b === 0x5c) { k++; continue; }
        if (inKeyQuote !== 0 && b === inKeyQuote) { inKeyQuote = 0; continue; }
        if (inKeyQuote === 0 && b === 0x3d) { eq = k; break; }
      }
      if (eq < 0) continue;
      let kStart = p;
      let kEnd = eq;
      while (kStart < kEnd && (slice[kStart] === 0x20 || slice[kStart] === 0x09)) kStart++;
      while (kEnd > kStart && (slice[kEnd - 1] === 0x20 || slice[kEnd - 1] === 0x09)) kEnd--;
      const keySlice = slice.subarray(kStart, kEnd);

      const isModelProviderKey = currentSection.kind === "root" && tomlBareOrQuotedMatchesAscii(keySlice, "model_provider");
      const isSecretKey = (currentSection.kind === "root" || currentSection.kind === "model_provider")
        && (
          tomlBareOrQuotedMatchesAscii(keySlice, "api_key")
          || tomlBareOrQuotedMatchesAscii(keySlice, "experimental_bearer_token")
          || tomlBareOrQuotedMatchesAscii(keySlice, "bearer_token")
        );
      if (!isModelProviderKey && !isSecretKey) continue;

      let vStart = eq + 1;
      while (vStart < slice.length && (slice[vStart] === 0x20 || slice[vStart] === 0x09)) vStart++;
      if (vStart >= slice.length) continue;
      const vEnd = findTomlQuotedEnd(slice, vStart);
      if (vEnd < 0) continue;
      const unesc = unescapeTomlStringBytes(slice.subarray(vStart + 1, vEnd), slice[vStart]!);
      if (!unesc) continue;
      ownedBuffers.push(unesc);

      if (isModelProviderKey) {
        modelProvider = encodeTrimmedAsciiHexKey(unesc);
        continue;
      }

      if (!extractKey) {
        if (validateCcSwitchApiKeyBytes(unesc) !== null) {
          if (currentSection.kind === "root") rootHasKey = true;
          else if (currentSection.kind === "model_provider") providerHasKey.add(currentSection.id);
        }
        continue;
      }

      const validatedCopy = copyValidatedSecretBytes(unesc);
      if (!validatedCopy) continue;
      if (currentSection.kind === "root") {
        // Prefer api_key over experimental_bearer_token if both exist.
        if (!rootKey || tomlBareOrQuotedMatchesAscii(keySlice, "api_key")) {
          if (rootKey) rootKey.fill(0);
          rootKey = validatedCopy;
        } else {
          validatedCopy.fill(0);
        }
      } else if (currentSection.kind === "model_provider") {
        const existing = providerKeys.get(currentSection.id);
        if (!existing || tomlBareOrQuotedMatchesAscii(keySlice, "api_key")) {
          existing?.fill(0);
          providerKeys.set(currentSection.id, validatedCopy);
        } else {
          validatedCopy.fill(0);
        }
      } else {
        validatedCopy.fill(0);
      }
    }

    if (!extractKey) {
      let has = false;
      if (modelProvider !== undefined) {
        has = providerHasKey.has(modelProvider) || rootHasKey;
      } else if (seenProviders.size === 1) {
        const onlyId = [...seenProviders][0]!;
        has = providerHasKey.has(onlyId) || rootHasKey;
      } else {
        has = rootHasKey;
      }
      return { hasApiKey: has };
    }

    let chosen: Uint8Array | null = null;
    if (modelProvider !== undefined) {
      chosen = providerKeys.get(modelProvider) ?? rootKey;
    } else if (seenProviders.size === 1) {
      const onlyId = [...seenProviders][0]!;
      chosen = providerKeys.get(onlyId) ?? rootKey;
    } else {
      chosen = rootKey;
    }
    if (!chosen) return { hasApiKey: false };
    const out = new Uint8Array(chosen.length);
    out.set(chosen);
    return { hasApiKey: true, keyBytes: out };
  } finally {
    for (const buf of ownedBuffers) buf.fill(0);
    rootKey?.fill(0);
    for (const buf of providerKeys.values()) buf.fill(0);
  }
}

function selectWinningSecretSlot(
  appType: string,
  present: ReadonlySet<SecretSlotName>,
): { slot: SecretSlotName; placement: CcSwitchSecretPlacement } | null {
  const app = appType.trim().toLowerCase();
  const order: Array<{ slot: SecretSlotName; placement: CcSwitchSecretPlacement }> =
    app === "claude"
      ? [
          { slot: "envAnthropicApiKey", placement: "anthropic-x-api-key" },
          { slot: "envAnthropicAuthToken", placement: "anthropic-bearer" },
          { slot: "topAnthropicApiKey", placement: "anthropic-x-api-key" },
          { slot: "topAnthropicAuthToken", placement: "anthropic-bearer" },
          { slot: "authAnthropicApiKey", placement: "anthropic-x-api-key" },
          { slot: "authAnthropicAuthToken", placement: "anthropic-bearer" },
          { slot: "topApiKey", placement: "anthropic-x-api-key" },
          { slot: "topAuthToken", placement: "anthropic-bearer" },
          { slot: "topToken", placement: "anthropic-x-api-key" },
          { slot: "topKey", placement: "anthropic-x-api-key" },
          { slot: "optionsApiKey", placement: "anthropic-x-api-key" },
          { slot: "authApiKey", placement: "anthropic-x-api-key" },
          { slot: "authToken", placement: "anthropic-x-api-key" },
          { slot: "authBearer", placement: "anthropic-bearer" },
          { slot: "envApiKey", placement: "anthropic-x-api-key" },
        ]
      : app === "codex"
        ? [
            { slot: "authOpenAiApiKey", placement: "key" },
            { slot: "envOpenAiApiKey", placement: "key" },
            { slot: "topOpenAiApiKey", placement: "key" },
            { slot: "tomlKey", placement: "key" },
            { slot: "topApiKey", placement: "key" },
            { slot: "authApiKey", placement: "key" },
            { slot: "authToken", placement: "key" },
            { slot: "authBearer", placement: "key" },
            { slot: "topAuthToken", placement: "key" },
            { slot: "topToken", placement: "key" },
            { slot: "topKey", placement: "key" },
            { slot: "envApiKey", placement: "key" },
          ]
        : app === "gemini"
          ? [
              { slot: "envGeminiApiKey", placement: "key" },
              { slot: "envGoogleApiKey", placement: "key" },
              { slot: "topGeminiApiKey", placement: "key" },
              { slot: "topGoogleApiKey", placement: "key" },
              { slot: "authGeminiApiKey", placement: "key" },
              { slot: "authGoogleApiKey", placement: "key" },
              { slot: "topApiKey", placement: "key" },
              { slot: "envApiKey", placement: "key" },
              { slot: "authApiKey", placement: "key" },
              { slot: "authToken", placement: "key" },
              { slot: "topAuthToken", placement: "key" },
              { slot: "topToken", placement: "key" },
              { slot: "topKey", placement: "key" },
            ]
          : [
              { slot: "envOpenAiApiKey", placement: "key" },
              { slot: "topOpenAiApiKey", placement: "key" },
              { slot: "topApiKey", placement: "key" },
              { slot: "optionsApiKey", placement: "key" },
              { slot: "authOpenAiApiKey", placement: "key" },
              { slot: "authApiKey", placement: "key" },
              { slot: "authToken", placement: "key" },
              { slot: "authBearer", placement: "key" },
              { slot: "topAuthToken", placement: "key" },
              { slot: "topToken", placement: "key" },
              { slot: "topKey", placement: "key" },
              { slot: "envApiKey", placement: "key" },
            ];
  for (const item of order) {
    if (present.has(item.slot)) return item;
  }
  return null;
}

/**
 * Inspect and optionally extract an API key from a CC-Switch `settings_config` JSON slice.
 * Caller owns zeroing `bytes`. All internal transient buffers are zeroed in `finally`.
 */
export function inspectSettingsSecretFromJsonBytes(
  bytes: Uint8Array,
  appType: string,
  extractKey: boolean,
): CcSwitchSecretInspection {
  let pos = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) pos = 3;

  const skipWs = () => {
    while (pos < bytes.length && (bytes[pos] === 0x20 || bytes[pos] === 0x09 || bytes[pos] === 0x0a || bytes[pos] === 0x0d)) {
      pos++;
    }
  };
  const scanStr = () => {
    const res = validateUtf8AndJsonStringBounds(bytes, pos);
    if (!res) throw new Error("malformed_settings_json");
    pos = res.nextPos;
    return res;
  };
  const skipPrim = () => {
    const s = pos;
    while (pos < bytes.length && ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x7d, 0x5d].includes(bytes[pos]!)) pos++;
    if (!validateJsonPrimitiveBytes(bytes, s, pos)) throw new Error("malformed_settings_json");
  };
  const skipVal = (depth = 0): void => {
    if (depth > 64) throw new Error("malformed_settings_json");
    skipWs();
    if (pos >= bytes.length) throw new Error("malformed_settings_json");
    const b = bytes[pos]!;
    if (b === 0x22) { scanStr(); return; }
    if (b === 0x7b) {
      pos++; skipWs();
      if (bytes[pos] === 0x7d) { pos++; return; }
      for (;;) {
        skipWs(); scanStr(); skipWs();
        if (bytes[pos] !== 0x3a) throw new Error("malformed_settings_json");
        pos++; skipVal(depth + 1); skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; return; }
        throw new Error("malformed_settings_json");
      }
    }
    if (b === 0x5b) {
      pos++; skipWs();
      if (bytes[pos] === 0x5d) { pos++; return; }
      for (;;) {
        skipVal(depth + 1); skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; return; }
        throw new Error("malformed_settings_json");
      }
    }
    skipPrim();
  };

  const present = new Set<SecretSlotName>();
  const captured = new Map<SecretSlotName, Uint8Array>();

  const captureStringSlot = (slot: SecretSlotName): void => {
    skipWs();
    if (bytes[pos] !== 0x22) {
      skipVal();
      return;
    }
    const strBounds = scanStr();
    const unesc = unescapeJsonStringBytesBounded(bytes, strBounds, MAX_CC_SWITCH_API_KEY_BYTES);
    if (!unesc) return;
    try {
      if (!extractKey) {
        if (validateCcSwitchApiKeyBytes(unesc) !== null) present.add(slot);
        return;
      }
      const validatedCopy = copyValidatedSecretBytes(unesc);
      if (validatedCopy) {
        present.add(slot);
        captured.get(slot)?.fill(0);
        captured.set(slot, validatedCopy);
      }
    } finally {
      unesc.fill(0);
    }
  };

  try {
    skipWs();
    if (pos >= bytes.length || bytes[pos] !== 0x7b) return { hasApiKey: false };
    pos++;
    skipWs();
    if (bytes[pos] !== 0x7d) {
      for (;;) {
        skipWs();
        const key = matchKnownJsonKeyBytes(bytes, scanStr(), [
          "env",
          "auth",
          "options",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "apiKey",
          "api_key",
          "authToken",
          "token",
          "key",
          "config",
        ]);
        skipWs();
        if (bytes[pos] !== 0x3a) return { hasApiKey: false };
        pos++;
        skipWs();
        if (key === "env" && bytes[pos] === 0x7b) {
          pos++; skipWs();
          if (bytes[pos] === 0x7d) { pos++; }
          else {
            for (;;) {
              skipWs();
              const envKey = matchKnownJsonKeyBytes(bytes, scanStr(), [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "OPENAI_API_KEY",
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "API_KEY",
              ]);
              skipWs();
              if (bytes[pos] !== 0x3a) return { hasApiKey: false };
              pos++;
              if (envKey === "ANTHROPIC_API_KEY") captureStringSlot("envAnthropicApiKey");
              else if (envKey === "ANTHROPIC_AUTH_TOKEN") captureStringSlot("envAnthropicAuthToken");
              else if (envKey === "OPENAI_API_KEY") captureStringSlot("envOpenAiApiKey");
              else if (envKey === "GEMINI_API_KEY") captureStringSlot("envGeminiApiKey");
              else if (envKey === "GOOGLE_API_KEY") captureStringSlot("envGoogleApiKey");
              else if (envKey === "API_KEY") captureStringSlot("envApiKey");
              else skipVal();
              skipWs();
              if (bytes[pos] === 0x2c) { pos++; continue; }
              if (bytes[pos] === 0x7d) { pos++; break; }
              return { hasApiKey: false };
            }
          }
        } else if (key === "auth" && bytes[pos] === 0x7b) {
          pos++; skipWs();
          if (bytes[pos] === 0x7d) { pos++; }
          else {
            for (;;) {
              skipWs();
              const authKey = matchKnownJsonKeyBytes(bytes, scanStr(), [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "apiKey",
                "api_key",
                "token",
                "bearer",
              ]);
              skipWs();
              if (bytes[pos] !== 0x3a) return { hasApiKey: false };
              pos++;
              if (authKey === "OPENAI_API_KEY") captureStringSlot("authOpenAiApiKey");
              else if (authKey === "ANTHROPIC_API_KEY") captureStringSlot("authAnthropicApiKey");
              else if (authKey === "ANTHROPIC_AUTH_TOKEN") captureStringSlot("authAnthropicAuthToken");
              else if (authKey === "GEMINI_API_KEY") captureStringSlot("authGeminiApiKey");
              else if (authKey === "GOOGLE_API_KEY") captureStringSlot("authGoogleApiKey");
              else if (authKey === "apiKey" || authKey === "api_key") captureStringSlot("authApiKey");
              else if (authKey === "token") captureStringSlot("authToken");
              else if (authKey === "bearer") captureStringSlot("authBearer");
              else skipVal();
              skipWs();
              if (bytes[pos] === 0x2c) { pos++; continue; }
              if (bytes[pos] === 0x7d) { pos++; break; }
              return { hasApiKey: false };
            }
          }
        } else if (key === "options" && bytes[pos] === 0x7b) {
          pos++; skipWs();
          if (bytes[pos] === 0x7d) { pos++; }
          else {
            for (;;) {
              skipWs();
              const optKey = matchKnownJsonKeyBytes(bytes, scanStr(), ["apiKey", "api_key"]);
              skipWs();
              if (bytes[pos] !== 0x3a) return { hasApiKey: false };
              pos++;
              if (optKey === "apiKey" || optKey === "api_key") captureStringSlot("optionsApiKey");
              else skipVal();
              skipWs();
              if (bytes[pos] === 0x2c) { pos++; continue; }
              if (bytes[pos] === 0x7d) { pos++; break; }
              return { hasApiKey: false };
            }
          }
        } else if (key === "OPENAI_API_KEY") {
          captureStringSlot("topOpenAiApiKey");
        } else if (key === "ANTHROPIC_API_KEY") {
          captureStringSlot("topAnthropicApiKey");
        } else if (key === "ANTHROPIC_AUTH_TOKEN") {
          captureStringSlot("topAnthropicAuthToken");
        } else if (key === "GEMINI_API_KEY") {
          captureStringSlot("topGeminiApiKey");
        } else if (key === "GOOGLE_API_KEY") {
          captureStringSlot("topGoogleApiKey");
        } else if (key === "apiKey" || key === "api_key") {
          captureStringSlot("topApiKey");
        } else if (key === "authToken") {
          captureStringSlot("topAuthToken");
        } else if (key === "token") {
          captureStringSlot("topToken");
        } else if (key === "key") {
          captureStringSlot("topKey");
        } else if (key === "config" && bytes[pos] === 0x22) {
          const tomlStrBounds = scanStr();
          const tomlBytes = unescapeJsonTomlBytesBounded(bytes, tomlStrBounds);
          if (tomlBytes) {
            try {
              const tomlSecret = inspectCodexTomlSecretBytes(tomlBytes, extractKey);
              if (tomlSecret.hasApiKey) {
                present.add("tomlKey");
                if (extractKey && tomlSecret.keyBytes) {
                  captured.get("tomlKey")?.fill(0);
                  captured.set("tomlKey", tomlSecret.keyBytes);
                }
              }
            } finally {
              tomlBytes.fill(0);
            }
          }
        } else {
          skipVal();
        }
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        return { hasApiKey: false };
      }
    }

    const winner = selectWinningSecretSlot(appType, present);
    if (!winner) return { hasApiKey: false };
    if (!extractKey) return { hasApiKey: true, placement: winner.placement };
    const winBytes = captured.get(winner.slot);
    if (!winBytes) return { hasApiKey: false };
    const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(winBytes);
    return { hasApiKey: true, apiKey, placement: winner.placement };
  } catch {
    return { hasApiKey: false };
  } finally {
    for (const buf of captured.values()) buf.fill(0);
  }
}
