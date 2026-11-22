export type PlaygroundEndpoint = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";

export interface PlaygroundTelemetry {
  status: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  throughputCps: number | null;
  tokens: number | null;
  tokensPerSec: number | null;
}

const MAX_RENDERED_CHARS = 256 * 1024;
const DEFAULT_PLAYGROUND_MODEL = "gpt-5.3-codex";

export { DEFAULT_PLAYGROUND_MODEL };

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildPlaygroundPayload(
  endpoint: PlaygroundEndpoint,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  stream: boolean,
  maxTokens?: number,
): Record<string, unknown> {
  const sys = systemPrompt.trim();
  const hasMax = typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0;
  if (endpoint === "/v1/chat/completions") {
    const messages = [
      ...(sys ? [{ role: "system", content: sys }] : []),
      { role: "user", content: userPrompt },
    ];
    return { model, messages, stream, ...(hasMax ? { max_tokens: maxTokens } : {}) };
  }
  if (endpoint === "/v1/responses") {
    return {
      model,
      ...(sys ? { instructions: sys } : {}),
      input: userPrompt,
      stream,
      ...(hasMax ? { max_output_tokens: maxTokens } : {}),
    };
  }
  return {
    model,
    max_tokens: hasMax ? maxTokens : 1024,
    ...(sys ? { system: sys } : {}),
    messages: [{ role: "user", content: userPrompt }],
    stream,
  };
}

export function buildPlaygroundCurl(
  apiBase: string,
  endpoint: PlaygroundEndpoint,
  payload: Record<string, unknown>,
): string {
  const base = apiBase ? apiBase.replace(/\/+$/, "") : (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8787");
  return [
    "curl -sS -N",
    `-X POST ${shellSingleQuote(`${base}${endpoint}`)}`,
    `-H ${shellSingleQuote("Content-Type: application/json")}`,
    `-d ${shellSingleQuote(JSON.stringify(payload))}`,
  ].join(" \\\n  ");
}

function extractTextFromJsonPayload(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.output_text === "string") return obj.output_text;

  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown> | undefined;
    const delta = first?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") return delta.content;
    if (typeof delta?.reasoning_content === "string") return delta.reasoning_content;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") return message.content;
  }

  if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
    return obj.delta;
  }
  if (obj.type === "content_block_delta") {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (typeof delta?.text === "string") return delta.text;
  }

  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const item of obj.content) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        const text = (item as { text: string }).text;
        if (text) parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (Array.isArray(obj.output)) {
    const out: string[] = [];
    for (const item of obj.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
            out.push((block as { text: string }).text);
          }
        }
      }
    }
    if (out.length > 0) return out.join("");
  }
  if (typeof obj.delta === "string") return obj.delta;
  return "";
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function extractUsageTokensFromPayload(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const responseObj = obj.response && typeof obj.response === "object" ? (obj.response as Record<string, unknown>) : null;
  const usage = (obj.usage && typeof obj.usage === "object"
    ? obj.usage
    : responseObj?.usage && typeof responseObj.usage === "object"
      ? responseObj.usage
      : null) as Record<string, unknown> | null;
  if (!usage) return null;
  return readPositiveInt(usage.output_tokens)
    ?? readPositiveInt(usage.completion_tokens)
    ?? readPositiveInt(usage.total_tokens);
}

function appendBounded(current: string, chunk: string, truncatedSuffix: string): { next: string; hitCap: boolean } {
  if (!chunk || current.length >= MAX_RENDERED_CHARS) {
    return { next: current, hitCap: current.length >= MAX_RENDERED_CHARS };
  }
  const remaining = MAX_RENDERED_CHARS - current.length;
  if (chunk.length <= remaining) {
    return { next: current + chunk, hitCap: false };
  }
  return { next: current + chunk.slice(0, remaining) + truncatedSuffix, hitCap: true };
}

export async function executePlaygroundRequest(options: {
  apiBase: string;
  endpoint: PlaygroundEndpoint;
  payload: Record<string, unknown>;
  stream: boolean;
  truncatedSuffix: string;
  signal: AbortSignal;
  onStatus: (status: number) => void;
  onOutput: (text: string) => void;
}): Promise<{ telemetry: PlaygroundTelemetry; httpErrorStatus: number | null }> {
  const { apiBase, endpoint, payload, stream, truncatedSuffix, signal, onStatus, onOutput } = options;
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let rendered = "";
  let hitCap = false;
  let usageTokens: number | null = null;

  const response = await fetch(`${apiBase}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  onStatus(response.status);

  if (response.ok && stream && contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIndex = buffer.indexOf("\n");
      while (nlIndex !== -1) {
        const rawLine = buffer.slice(0, nlIndex).trim();
        buffer = buffer.slice(nlIndex + 1);
        nlIndex = buffer.indexOf("\n");
        if (!rawLine.startsWith("data:")) continue;
        const dataStr = rawLine.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let piece: string;
        try {
          const parsedData = JSON.parse(dataStr);
          piece = extractTextFromJsonPayload(parsedData);
          const tok = extractUsageTokensFromPayload(parsedData);
          if (tok !== null) usageTokens = tok;
        } catch {
          piece = dataStr;
        }
        if (piece) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          if (!hitCap) {
            const appended = appendBounded(rendered, piece, truncatedSuffix);
            rendered = appended.next;
            hitCap = appended.hitCap;
            onOutput(rendered);
          }
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:") && tail.slice(5).trim() !== "[DONE]") {
      try {
        const parsedTail = JSON.parse(tail.slice(5).trim());
        const tok = extractUsageTokensFromPayload(parsedTail);
        if (tok !== null) usageTokens = tok;
        const piece = extractTextFromJsonPayload(parsedTail);
        if (piece && !hitCap) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          rendered = appendBounded(rendered, piece, truncatedSuffix).next;
          onOutput(rendered);
        }
      } catch { /* Ignore incomplete final SSE line. */ }
    }
  } else {
    const rawText = await response.text();
    firstTokenAt ??= performance.now();
    let formatted = rawText;
    if (contentType.includes("application/json") || rawText.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(rawText) as { error?: { message?: unknown } };
        const tok = extractUsageTokensFromPayload(parsed);
        if (tok !== null) usageTokens = tok;
        const extracted = response.ok ? extractTextFromJsonPayload(parsed) : "";
        formatted = extracted || JSON.stringify(parsed, null, 2);
      } catch {
        formatted = rawText;
      }
    }
    rendered = appendBounded("", formatted, truncatedSuffix).next;
    onOutput(rendered);
  }

  const endedAt = performance.now();
  const totalMs = Math.max(1, Math.round(endedAt - startedAt));
  const ttftMs = firstTokenAt !== null ? Math.max(0, Math.round(firstTokenAt - startedAt)) : totalMs;
  const throughputCps = rendered.length > 0 ? Math.round((rendered.length / totalMs) * 1000) : 0;
  const tokensPerSec = usageTokens !== null && totalMs > 0 ? Math.round((usageTokens / totalMs) * 1000) : null;

  return {
    telemetry: { status: response.status, ttftMs, totalMs, throughputCps, tokens: usageTokens, tokensPerSec },
    httpErrorStatus: response.ok ? null : response.status,
  };
}

export async function fetchPlaygroundModelIds(
  apiBase: string,
  signal: AbortSignal,
  limit = 256,
): Promise<string[]> {
  const res = await fetch(`${apiBase}/v1/models`, { signal });
  if (!res.ok) return [];
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body?.data)) return [];
  const ids: string[] = [];
  for (const row of body.data) {
    if (typeof row?.id !== "string") continue;
    const trimmed = row.id.trim();
    if (!trimmed) continue;
    ids.push(trimmed);
    if (ids.length >= limit) break;
  }
  return ids;
}
