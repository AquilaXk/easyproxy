export type PlaygroundEndpoint = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
export type PlaygroundEffort = "" | "low" | "medium" | "high" | "xhigh";

export interface PlaygroundTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PlaygroundSeed {
  endpoint?: PlaygroundEndpoint;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  turns?: PlaygroundTurn[];
  maxTokens?: number;
  temperature?: number;
  effort?: PlaygroundEffort;
  serviceTier?: string;
}

export interface PlaygroundPayloadOptions {
  temperature?: number;
  effort?: PlaygroundEffort;
  serviceTier?: string;
  turns?: readonly PlaygroundTurn[];
}

export interface PlaygroundTelemetry {
  status: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  throughputCps: number | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
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
  options?: PlaygroundPayloadOptions,
): Record<string, unknown> {
  const sys = systemPrompt.trim();
  const hasMax = typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0;
  const hasTemp = typeof options?.temperature === "number"
    && Number.isFinite(options.temperature)
    && options.temperature >= 0
    && options.temperature <= 2;
  const effort = options?.effort && options.effort.trim() ? options.effort.trim() : "";
  const serviceTier = options?.serviceTier && options.serviceTier.trim() ? options.serviceTier.trim() : "";
  const explicitTurns = options?.turns && options.turns.length > 0
    ? options.turns.map(turn => ({ role: turn.role, content: turn.content }))
    : [{ role: "user" as const, content: userPrompt }];
  const multiTurn = explicitTurns.length > 1 || (explicitTurns.length === 1 && explicitTurns[0]!.role !== "user");

  if (endpoint === "/v1/chat/completions") {
    const messages = [
      ...(sys ? [{ role: "system", content: sys }] : []),
      ...explicitTurns,
    ];
    return {
      model,
      messages,
      stream,
      ...(hasMax ? { max_tokens: maxTokens } : {}),
      ...(hasTemp ? { temperature: options!.temperature } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    };
  }
  if (endpoint === "/v1/responses") {
    return {
      model,
      ...(sys ? { instructions: sys } : {}),
      input: multiTurn ? explicitTurns : (explicitTurns[0]?.content ?? userPrompt),
      stream,
      ...(hasMax ? { max_output_tokens: maxTokens } : {}),
      ...(hasTemp ? { temperature: options!.temperature } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    };
  }
  return {
    model,
    max_tokens: hasMax ? maxTokens : 1024,
    ...(sys ? { system: sys } : {}),
    messages: explicitTurns,
    stream,
    ...(hasTemp ? { temperature: options!.temperature } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
}

export function buildPlaygroundCurl(
  apiBase: string,
  endpoint: PlaygroundEndpoint,
  payload: Record<string, unknown>,
): string {
  const base = apiBase ? apiBase.replace(/\/+$/, "") : (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:10100");
  return [
    "curl -sS -N",
    `-X POST ${shellSingleQuote(`${base}${endpoint}`)}`,
    `-H ${shellSingleQuote("Content-Type: application/json")}`,
    `-H ${shellSingleQuote("Authorization: Bearer YOUR_API_KEY")}`,
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

interface UsageExtract {
  input: number | null;
  output: number | null;
  total: number | null;
}

function extractUsageTokensFromPayload(parsed: unknown): UsageExtract | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const responseObj = obj.response && typeof obj.response === "object" ? (obj.response as Record<string, unknown>) : null;
  const messageObj = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : null;
  const usage = (obj.usage && typeof obj.usage === "object"
    ? obj.usage
    : responseObj?.usage && typeof responseObj.usage === "object"
      ? responseObj.usage
      : messageObj?.usage && typeof messageObj.usage === "object"
        ? messageObj.usage
        : null) as Record<string, unknown> | null;
  if (!usage) return null;
  const input = readPositiveInt(usage.input_tokens) ?? readPositiveInt(usage.prompt_tokens);
  const output = readPositiveInt(usage.output_tokens) ?? readPositiveInt(usage.completion_tokens);
  const total = readPositiveInt(usage.total_tokens);
  if (input === null && output === null && total === null) return null;
  return { input, output, total };
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
}): Promise<{ telemetry: PlaygroundTelemetry; httpErrorStatus: number | null; errorDetail: string | null }> {
  const { apiBase, endpoint, payload, stream, truncatedSuffix, signal, onStatus, onOutput } = options;
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let rendered = "";
  let hitCap = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalUsageTokens: number | null = null;
  let errorDetail: string | null = null;

  const mergeUsage = (u: UsageExtract | null) => {
    if (!u) return;
    if (u.input !== null) inputTokens = u.input;
    if (u.output !== null) outputTokens = u.output;
    if (u.total !== null) totalUsageTokens = u.total;
  };

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
          mergeUsage(extractUsageTokensFromPayload(parsedData));
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
        mergeUsage(extractUsageTokensFromPayload(parsedTail));
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
        const parsed = JSON.parse(rawText) as { error?: { message?: unknown }; message?: unknown };
        mergeUsage(extractUsageTokensFromPayload(parsed));
        if (!response.ok) {
          const rawMsg = typeof parsed?.error?.message === "string"
            ? parsed.error.message
            : typeof parsed?.message === "string"
              ? parsed.message
              : "";
          if (rawMsg.trim()) errorDetail = rawMsg.trim().slice(0, 240);
        }
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
  const usageTokens = outputTokens ?? totalUsageTokens ?? inputTokens;
  const rateBasis = outputTokens ?? usageTokens;
  const tokensPerSec = rateBasis !== null && totalMs > 0 ? Math.round((rateBasis / totalMs) * 1000) : null;

  return {
    telemetry: {
      status: response.status,
      ttftMs,
      totalMs,
      throughputCps,
      tokens: usageTokens,
      inputTokens,
      outputTokens,
      tokensPerSec,
    },
    httpErrorStatus: response.ok ? null : response.status,
    errorDetail,
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
