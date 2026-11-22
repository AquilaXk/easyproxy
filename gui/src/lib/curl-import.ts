import type { PlaygroundEffort, PlaygroundEndpoint, PlaygroundSeed, PlaygroundTurn } from "./playground-client";

export const MAX_CURL_IMPORT_BYTES = 65_536;
const MAX_CURL_TOKENS = 2048;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

export type CurlImportErrorCode =
  | "empty"
  | "too_large"
  | "unterminated_quote"
  | "not_curl"
  | "missing_body"
  | "invalid_json";

export interface ParsedCurlPlaygroundRequest {
  endpoint: PlaygroundEndpoint;
  seed: PlaygroundSeed;
  stream?: boolean;
}

export type CurlImportResult =
  | { ok: true; value: ParsedCurlPlaygroundRequest }
  | { ok: false; errorCode: CurlImportErrorCode };

function decodeAnsiCEscape(source: string, index: number): { char: string; next: number } {
  const esc = source[index];
  if (esc === undefined) return { char: "", next: index };
  switch (esc) {
    case "n": return { char: "\n", next: index + 1 };
    case "r": return { char: "\r", next: index + 1 };
    case "t": return { char: "\t", next: index + 1 };
    case "\\": return { char: "\\", next: index + 1 };
    case "'": return { char: "'", next: index + 1 };
    case '"': return { char: '"', next: index + 1 };
    default: return { char: `\\${esc}`, next: index + 1 };
  }
}

function tokenizeCurlCommand(input: string): { ok: true; tokens: string[] } | { ok: false; errorCode: CurlImportErrorCode } {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;

  const pushToken = () => {
    if (!hasToken) return;
    tokens.push(current);
    current = "";
    hasToken = false;
  };

  while (i < input.length) {
    if (tokens.length >= MAX_CURL_TOKENS) {
      return { ok: false, errorCode: "too_large" };
    }
    const ch = input[i]!;

    if (ch === "\\" && (input[i + 1] === "\n" || (input[i + 1] === "\r" && input[i + 2] === "\n"))) {
      i += input[i + 1] === "\r" ? 3 : 2;
      continue;
    }

    if (/\s/.test(ch)) {
      pushToken();
      i += 1;
      continue;
    }

    if (ch === "$" && input[i + 1] === "'") {
      hasToken = true;
      i += 2;
      let closed = false;
      while (i < input.length) {
        const inner = input[i]!;
        if (inner === "'") {
          i += 1;
          closed = true;
          break;
        }
        if (inner === "\\") {
          const decoded = decodeAnsiCEscape(input, i + 1);
          current += decoded.char;
          i = decoded.next;
          continue;
        }
        current += inner;
        i += 1;
      }
      if (!closed) return { ok: false, errorCode: "unterminated_quote" };
      continue;
    }

    if (ch === "'") {
      hasToken = true;
      i += 1;
      const closeIdx = input.indexOf("'", i);
      if (closeIdx === -1) return { ok: false, errorCode: "unterminated_quote" };
      current += input.slice(i, closeIdx);
      i = closeIdx + 1;
      continue;
    }

    if (ch === '"') {
      hasToken = true;
      i += 1;
      let closed = false;
      while (i < input.length) {
        const inner = input[i]!;
        if (inner === '"') {
          i += 1;
          closed = true;
          break;
        }
        if (inner === "\\") {
          const next = input[i + 1];
          if (next === "\n" || (next === "\r" && input[i + 2] === "\n")) {
            i += next === "\r" ? 3 : 2;
            continue;
          }
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            current += next;
            i += 2;
            continue;
          }
        }
        current += inner;
        i += 1;
      }
      if (!closed) return { ok: false, errorCode: "unterminated_quote" };
      continue;
    }

    if (ch === "\\") {
      hasToken = true;
      const next = input[i + 1];
      if (next !== undefined) {
        current += next;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    hasToken = true;
    current += ch;
    i += 1;
  }

  pushToken();
  return { ok: true, tokens };
}

function exceedsJsonDepthOrNodes(value: unknown, depth = 0, counter = { nodes: 0 }): boolean {
  if (depth > MAX_JSON_DEPTH) return true;
  counter.nodes += 1;
  if (counter.nodes > MAX_JSON_NODES) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (exceedsJsonDepthOrNodes(item, depth + 1, counter)) return true;
    }
    return false;
  }
  if (value !== null && typeof value === "object") {
    for (const val of Object.values(value as Record<string, unknown>)) {
      if (exceedsJsonDepthOrNodes(val, depth + 1, counter)) return true;
    }
  }
  return false;
}

function endpointFromUrlPath(rawUrl: string): PlaygroundEndpoint | null {
  try {
    const pathname = new URL(rawUrl).pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/chat/completions")) return "/v1/chat/completions";
    if (pathname.endsWith("/responses")) return "/v1/responses";
    if (pathname.endsWith("/messages")) return "/v1/messages";
  } catch {
    /* invalid URL */
  }
  return null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const rec = block as Record<string, unknown>;
      if (typeof rec.text === "string" && rec.text) {
        parts.push(rec.text);
      } else if (typeof rec.input_text === "string" && rec.input_text) {
        parts.push(rec.input_text);
      }
    }
  }
  return parts.join("\n");
}

function normalizeEffort(raw: unknown): PlaygroundEffort | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "low" || trimmed === "medium" || trimmed === "high" || trimmed === "xhigh") {
    return trimmed;
  }
  return undefined;
}

const VALUE_FLAGS = new Set([
  "-X", "--request",
  "-H", "--header",
  "-u", "--user",
  "-A", "--user-agent",
  "-e", "--referer",
  "-m", "--max-time",
  "--connect-timeout",
  "--retry",
  "-o", "--output",
  "-w", "--write-out",
  "-x", "--proxy",
  "--cacert", "--cert", "--key", "--resolve",
]);

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json"]);

function extractCurlFields(tokens: string[]): { url: string | null; bodyText: string | null } {
  let idx = 0;
  // Skip leading env assignments (e.g., KEY=val curl ...)
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
    idx += 1;
  }
  const cmd = tokens[idx] ?? "";
  const base = cmd.split("/").pop()?.toLowerCase();
  if (base !== "curl") return { url: null, bodyText: "__NOT_CURL__" };
  idx += 1;

  let url: string | null = null;
  const bodies: string[] = [];

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (DATA_FLAGS.has(tok)) {
      if (idx + 1 < tokens.length) {
        bodies.push(tokens[idx + 1]!);
        idx += 2;
        continue;
      }
      idx += 1;
      continue;
    }
    if (tok.startsWith("--data=") || tok.startsWith("--data-raw=") || tok.startsWith("--data-binary=") || tok.startsWith("--json=")) {
      bodies.push(tok.slice(tok.indexOf("=") + 1));
      idx += 1;
      continue;
    }
    if (tok.startsWith("-d") && tok.length > 2) {
      bodies.push(tok.slice(2));
      idx += 1;
      continue;
    }
    if (tok === "--url") {
      if (idx + 1 < tokens.length) {
        url = tokens[idx + 1]!;
        idx += 2;
        continue;
      }
      idx += 1;
      continue;
    }
    if (tok.startsWith("--url=")) {
      url = tok.slice(6);
      idx += 1;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      idx += idx + 1 < tokens.length ? 2 : 1;
      continue;
    }
    if (tok.startsWith("-")) {
      idx += 1;
      continue;
    }
    if (!url && /^https?:\/\//i.test(tok)) {
      url = tok;
    }
    idx += 1;
  }

  return { url, bodyText: bodies.length > 0 ? bodies[bodies.length - 1]! : null };
}

/** Parse a pasted `curl` command into Playground settings, failing closed on invalid or oversized input. */
export function parseCurlToPlaygroundRequest(raw: string): CurlImportResult {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > MAX_CURL_IMPORT_BYTES) {
    return { ok: false, errorCode: "too_large" };
  }
  if (!raw.trim()) {
    return { ok: false, errorCode: "empty" };
  }

  const tokenized = tokenizeCurlCommand(raw);
  if (!tokenized.ok) return tokenized;
  if (tokenized.tokens.length === 0) return { ok: false, errorCode: "empty" };

  const { url, bodyText } = extractCurlFields(tokenized.tokens);
  if (bodyText === "__NOT_CURL__") {
    return { ok: false, errorCode: "not_curl" };
  }
  if (!bodyText) {
    return { ok: false, errorCode: "missing_body" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, errorCode: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || exceedsJsonDepthOrNodes(parsed)) {
    return { ok: false, errorCode: "invalid_json" };
  }

  const obj = parsed as Record<string, unknown>;
  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined;

  let systemPrompt: string | undefined;
  if (typeof obj.instructions === "string") {
    systemPrompt = obj.instructions;
  } else if (typeof obj.system === "string" || Array.isArray(obj.system)) {
    const text = extractTextContent(obj.system);
    if (text) systemPrompt = text;
  }

  const conversationTurns: PlaygroundTurn[] = [];
  const collectMessageArray = (rows: unknown[]) => {
    for (const item of rows) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const msg = item as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role.trim().toLowerCase() : "";
      const text = extractTextContent(msg.content);
      if ((role === "system" || role === "developer") && systemPrompt === undefined && text) {
        systemPrompt = text;
      } else if (role === "user" || role === "assistant") {
        conversationTurns.push({ role, content: text });
      }
    }
  };

  let userPrompt: string | undefined;
  if (Array.isArray(obj.messages)) {
    collectMessageArray(obj.messages);
  } else if (typeof obj.input === "string") {
    userPrompt = obj.input;
  } else if (Array.isArray(obj.input)) {
    collectMessageArray(obj.input);
    if (conversationTurns.length === 0) {
      const text = extractTextContent(obj.input);
      if (text) userPrompt = text;
    }
  }

  let turns: PlaygroundTurn[] | undefined;
  if (conversationTurns.length > 0) {
    let lastUserIdx = -1;
    for (let i = conversationTurns.length - 1; i >= 0; i--) {
      if (conversationTurns[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === conversationTurns.length - 1) {
      userPrompt = conversationTurns[lastUserIdx]!.content;
      if (lastUserIdx > 0) turns = conversationTurns.slice(0, lastUserIdx);
    } else if (lastUserIdx >= 0) {
      userPrompt = conversationTurns[lastUserIdx]!.content;
      turns = conversationTurns;
    } else {
      turns = conversationTurns;
    }
  }

  const rawMaxTokens = obj.max_output_tokens ?? obj.max_tokens;
  const maxTokens = typeof rawMaxTokens === "number" && Number.isSafeInteger(rawMaxTokens) && rawMaxTokens > 0 && rawMaxTokens <= 1_000_000
    ? rawMaxTokens
    : undefined;

  const temperature = typeof obj.temperature === "number" && Number.isFinite(obj.temperature) && obj.temperature >= 0 && obj.temperature <= 2
    ? obj.temperature
    : undefined;

  const reasoningObj = obj.reasoning && typeof obj.reasoning === "object" && !Array.isArray(obj.reasoning)
    ? (obj.reasoning as Record<string, unknown>)
    : null;
  const outputConfigObj = obj.output_config && typeof obj.output_config === "object" && !Array.isArray(obj.output_config)
    ? (obj.output_config as Record<string, unknown>)
    : null;
  const effort = normalizeEffort(obj.reasoning_effort ?? reasoningObj?.effort ?? outputConfigObj?.effort);

  const serviceTier = typeof obj.service_tier === "string" && obj.service_tier.trim()
    ? obj.service_tier.trim()
    : undefined;

  const stream = typeof obj.stream === "boolean" ? obj.stream : undefined;

  const urlEndpoint = url ? endpointFromUrlPath(url) : null;
  const endpoint: PlaygroundEndpoint = urlEndpoint
    ?? (obj.input !== undefined || obj.instructions !== undefined || obj.max_output_tokens !== undefined
      ? "/v1/responses"
      : obj.system !== undefined || outputConfigObj !== null
        ? "/v1/messages"
        : "/v1/chat/completions");

  if (!model && !userPrompt && !systemPrompt && (!turns || turns.length === 0)) {
    return { ok: false, errorCode: "invalid_json" };
  }

  const seed: PlaygroundSeed = {
    endpoint,
    ...(model ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(userPrompt !== undefined ? { userPrompt } : {}),
    ...(turns ? { turns } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };

  return {
    ok: true,
    value: {
      endpoint,
      seed,
      ...(stream !== undefined ? { stream } : {}),
    },
  };
}
