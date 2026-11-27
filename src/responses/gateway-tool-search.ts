// Ported from maximhq/bifrost (core/toolsearch/toolsearch.go & core/toolsearch/search.go, Apache-2.0).
// Opt-in gateway-side `defer_loading` (`tool_search`) emulation for non-Anthropic targets that do
// not support native server-side deferred tool loading.

import { assistantReplayContent } from "./assistant-replay";
import { AdvisorRetention } from "../server/responses/advisor-retention";
import { mergeUsage } from "../server/responses/empty-completion-guard";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "../lib/errors";
import { jsonStringPartsUtf8Bytes, jsonUtf8Bytes } from "../lib/json-byte-size";
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  TRANSLATOR_MAX_CALL_ARGUMENT_BYTES,
  TranslatorBudgetExceededError,
} from "../lib/translator-budget";
import type {
  AdapterEvent,
  EpxAssistantMessage,
  EpxMessage,
  EpxParsedRequest,
  EpxProviderConfig,
  EpxTool,
  EpxToolResultMessage,
  EpxUsage,
} from "../types";
import { namespacedToolName, toolChoiceToolPredicate } from "../types";

export const GATEWAY_TOOL_SEARCH_TOOL_NAME = "epx_tool_search";
export const GATEWAY_TOOL_SEARCH_MAX_TURNS = 3;
export const GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT = 5;
export const GATEWAY_TOOL_SEARCH_MAX_LIMIT = 20;
export const GATEWAY_TOOL_SEARCH_MAX_LISTED_TOOLS = 200;
export const GATEWAY_TOOL_SEARCH_MAX_DESC_CHARS = 120;
export const GATEWAY_TOOL_SEARCH_MAX_QUERY_BYTES = 512;
export const GATEWAY_TOOL_SEARCH_MAX_CATALOG = 512;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_LEG_TEXT_CHARS = 64 * 1024;
const MAX_LEG_THINKING_CHARS = 64 * 1024;
const MAX_DOC_TERMS = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wireKeyForTool(tool: Pick<EpxTool, "namespace" | "name">): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function hasExplicitClientToolSearch(parsed: EpxParsedRequest): boolean {
  const raw = parsed._rawBody;
  if (isPlainObject(raw) && Array.isArray(raw.tools)) {
    for (const entry of raw.tools) {
      if (isPlainObject(entry) && entry.type === "tool_search" && entry.execution !== "server") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Reports whether the request qualifies for gateway-side `defer_loading` (`tool_search`)
 * emulation on a non-Anthropic adapter target. Stateful provider continuations
 * (`previous_response_id` / `conversation`) and client-owned `tool_search` declarations stay
 * excluded so loaded tool state stays strictly request-derived and predictable.
 */
export function isGatewayToolSearchCandidate(
  parsed: EpxParsedRequest,
  provider: Pick<EpxProviderConfig, "adapter" | "gatewayToolSearch">,
): boolean {
  if (provider.gatewayToolSearch !== true) return false;
  if (provider.adapter === "anthropic") return false;
  if (parsed._compactionRequest || parsed._summaryProhibitsToolCalls) return false;
  if (parsed.options.toolChoice === "none") return false;
  const raw = parsed._rawBody;
  if (parsed.previousResponseId) return false;
  if (isPlainObject(raw) && (raw.previous_response_id !== undefined || raw.conversation !== undefined)) {
    return false;
  }
  const tools = parsed.context.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  if (hasExplicitClientToolSearch(parsed)) return false;
  return tools.some(tool => tool.deferLoading === true);
}

/**
 * Tokenizes identifiers (`snake_case`, `camelCase`, dots, hyphens) and descriptions into
 * normalized lowercase terms with a strict per-document cap.
 */
export function tokenizeToolSearchDocument(text: string): string[] {
  if (!text) return [];
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase();
  const terms: string[] = [];
  for (const part of expanded.split(" ")) {
    if (!part) continue;
    terms.push(part);
    if (terms.length >= MAX_DOC_TERMS) break;
  }
  return terms;
}

function toolDocumentTerms(tool: EpxTool): string[] {
  const parts: string[] = [tool.name];
  if (tool.namespace) parts.push(tool.namespace);
  if (tool.description) parts.push(tool.description);
  const props = isPlainObject(tool.parameters) && isPlainObject(tool.parameters.properties)
    ? Object.keys(tool.parameters.properties)
    : [];
  for (let i = 0; i < props.length && i < 32; i++) parts.push(props[i]!);
  return tokenizeToolSearchDocument(parts.join(" "));
}

function parseSearchArgs(rawArgs: string): { query: string; limit: number } {
  const trimmed = rawArgs.trim();
  if (!trimmed) return { query: "", limit: GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) return { query: "", limit: GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT };
    let query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    if (Buffer.byteLength(query, "utf8") > GATEWAY_TOOL_SEARCH_MAX_QUERY_BYTES) {
      query = query.slice(0, GATEWAY_TOOL_SEARCH_MAX_QUERY_BYTES);
    }
    const rawLimit = typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
      ? Math.trunc(parsed.limit)
      : GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(GATEWAY_TOOL_SEARCH_MAX_LIMIT, rawLimit));
    return { query, limit };
  } catch {
    return { query: "", limit: GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT };
  }
}

/**
 * Ranks deferred tools matching `query` via `"select:name1,name2"` exact selection, BM25
 * (`k1=1.2, b=0.75`), or a case-insensitive literal substring fallback.
 */
export function searchDeferredTools(
  tools: readonly EpxTool[],
  rawQuery: string,
  limit = GATEWAY_TOOL_SEARCH_DEFAULT_LIMIT,
): EpxTool[] {
  const query = rawQuery.trim().slice(0, GATEWAY_TOOL_SEARCH_MAX_QUERY_BYTES);
  const cappedLimit = Math.max(1, Math.min(GATEWAY_TOOL_SEARCH_MAX_LIMIT, Math.trunc(limit)));
  if (!query || tools.length === 0) return [];

  if (query.toLowerCase().startsWith("select:")) {
    const requested = query.slice("select:".length).split(",");
    const picked: EpxTool[] = [];
    const seen = new Set<string>();
    for (const rawName of requested) {
      const target = rawName.trim();
      if (!target) continue;
      const match = tools.find(tool => wireKeyForTool(tool) === target || tool.name === target);
      if (match) {
        const key = wireKeyForTool(match);
        if (!seen.has(key)) {
          seen.add(key);
          picked.push(match);
        }
      }
      if (picked.length >= cappedLimit) break;
    }
    return picked;
  }

  const queryTerms = tokenizeToolSearchDocument(query);
  if (queryTerms.length > 0) {
    const docs = tools.map(toolDocumentTerms);
    const totalLen = docs.reduce((sum, doc) => sum + doc.length, 0);
    const avgLen = Math.max(1, totalLen / docs.length);
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
      for (const term of new Set(doc)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const n = docs.length;
    const scored: Array<{ tool: EpxTool; score: number }> = [];
    for (let i = 0; i < tools.length; i++) {
      const doc = docs[i]!;
      if (doc.length === 0) continue;
      const tf = new Map<string, number>();
      for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const freq = tf.get(term) ?? 0;
        if (freq === 0) continue;
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
        score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgLen))));
      }
      if (score > 0) scored.push({ tool: tools[i]!, score });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score || wireKeyForTool(a.tool).localeCompare(wireKeyForTool(b.tool)));
      return scored.slice(0, cappedLimit).map(entry => entry.tool);
    }
  }

  // Literal case-insensitive substring fallback with zero RegExp compilation on untrusted queries.
  const queryLower = query.toLowerCase();
  const matched: EpxTool[] = [];
  for (const tool of tools) {
    const wire = wireKeyForTool(tool);
    if (
      wire.toLowerCase().includes(queryLower)
      || (tool.description ?? "").toLowerCase().includes(queryLower)
    ) {
      matched.push(tool);
      if (matched.length >= cappedLimit) break;
    }
  }
  return matched;
}

function chooseGatewaySearchWireName(tools: readonly EpxTool[]): string {
  const used = new Set(tools.map(wireKeyForTool));
  if (!used.has(GATEWAY_TOOL_SEARCH_TOOL_NAME)) return GATEWAY_TOOL_SEARCH_TOOL_NAME;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${GATEWAY_TOOL_SEARCH_TOOL_NAME}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function stripDeferFlag(tool: EpxTool): EpxTool {
  if (!tool.deferLoading) return tool;
  const { deferLoading: _drop, ...rest } = tool;
  return rest;
}

export interface GatewayToolSearchSession {
  wireName: string;
  deferred: EpxTool[];
  eager: EpxTool[];
  loaded: Set<string>;
  remainingTurns: number;
  buildActiveTools(includeSearch: boolean): EpxTool[];
  buildSearchTool(): EpxTool;
}

function createGatewayToolSearchSession(parsed: EpxParsedRequest): GatewayToolSearchSession | null {
  const allTools = parsed.context.tools ?? [];
  if (allTools.length === 0) return null;

  const eager: EpxTool[] = [];
  const deferred: EpxTool[] = [];
  for (const tool of allTools) {
    if (tool.toolSearch) continue;
    if (tool.deferLoading === true && deferred.length < GATEWAY_TOOL_SEARCH_MAX_CATALOG) {
      deferred.push(tool);
    } else {
      eager.push(stripDeferFlag(tool));
    }
  }
  if (deferred.length === 0) return null;

  const loaded = new Set<string>();
  const deferredKeys = new Set(deferred.map(wireKeyForTool));

  // Preload deferred tools already called in conversation history.
  for (const msg of parsed.context.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "toolCall" && typeof part.name === "string" && deferredKeys.has(part.name)) {
        loaded.add(part.name);
      }
    }
  }

  // Preload deferred tools explicitly selected or allowed by tool_choice.
  const choice = parsed.options.toolChoice;
  if (choice && typeof choice === "object") {
    const allowedFn = toolChoiceToolPredicate(choice, deferred);
    for (const tool of deferred) {
      if (allowedFn(tool)) loaded.add(wireKeyForTool(tool));
    }
  }

  const wireName = chooseGatewaySearchWireName(allTools);

  const session: GatewayToolSearchSession = {
    wireName,
    deferred,
    eager,
    loaded,
    remainingTurns: GATEWAY_TOOL_SEARCH_MAX_TURNS,
    buildSearchTool(): EpxTool {
      const unloaded = deferred.filter(tool => !loaded.has(wireKeyForTool(tool)));
      const lines: string[] = [
        "Search deferred tools that are available on this request and load matching schemas for subsequent calls.",
        'Pass descriptive keywords (query) or "select:<name1>,<name2>" to load tools by exact name.',
        "Available deferred tools:",
      ];
      for (let i = 0; i < unloaded.length && i < GATEWAY_TOOL_SEARCH_MAX_LISTED_TOOLS; i++) {
        const tool = unloaded[i]!;
        const desc = (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, GATEWAY_TOOL_SEARCH_MAX_DESC_CHARS);
        lines.push(desc ? `- ${wireKeyForTool(tool)}: ${desc}` : `- ${wireKeyForTool(tool)}`);
      }
      if (unloaded.length > GATEWAY_TOOL_SEARCH_MAX_LISTED_TOOLS) {
        lines.push(`- ... and ${unloaded.length - GATEWAY_TOOL_SEARCH_MAX_LISTED_TOOLS} more`);
      }
      return {
        name: wireName,
        description: lines.join("\n"),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords or select:<tool_names> query." },
            limit: { type: "integer", minimum: 1, maximum: GATEWAY_TOOL_SEARCH_MAX_LIMIT, description: "Max tools to load (default 5)." },
          },
          required: ["query"],
        },
        gatewayToolSearch: true,
      };
    },
    buildActiveTools(includeSearch: boolean): EpxTool[] {
      const next: EpxTool[] = [...eager];
      for (const tool of deferred) {
        if (loaded.has(wireKeyForTool(tool))) {
          next.push(stripDeferFlag(tool));
        }
      }
      const hasUnloaded = loaded.size < deferred.length;
      if (includeSearch && hasUnloaded && session.remainingTurns > 0) {
        next.push(session.buildSearchTool());
      }
      return next;
    },
  };

  return session;
}

interface HeldSearchCall {
  id: string;
  name: string;
  args: string[];
  argumentBytes: number;
  closed: boolean;
  providerMetadata?: import("../types").EpxProviderOpaqueToolCallMetadata;
}

function createGatewayToolSearchGuard(session: GatewayToolSearchSession): NonNullable<EpxParsedRequest["_gatewayToolSearchGuard"]> {
  return async function* gatewayToolSearchGuard(options): AsyncGenerator<AdapterEvent> {
    let parsed = options.parsed;
    let source = options.firstEvents;
    let accumulatedUsage: EpxUsage | undefined;
    const retention = new AdvisorRetention(options.translatorBudget);

    try {
      for (;;) {
        const held: HeldSearchCall[] = [];
        const legEvents: AdapterEvent[] = [];
        let legTextChars = 0;
        let legThinkingChars = 0;
        let pending: HeldSearchCall | null = null;
        let holdingCurrent = false;
        let hasRealToolCall = false;
        let hasIncompleteToolCall = false;
        let terminalConsumed = false;
        let terminalEvent: Extract<AdapterEvent, { type: "done" }> | undefined;

        for await (const event of source) {
          if (event.type === "tool_call_start") {
            const isSearch = event.name === session.wireName;
            if (pending) { held.push(pending); pending = null; }
            holdingCurrent = isSearch;
            if (!isSearch) {
              hasRealToolCall = true;
              held.length = legEvents.length = 0;
              retention.releaseLeg();
            } else {
              if (!hasRealToolCall) {
                retention.retain(event, true);
                pending = {
                  id: event.id,
                  name: event.name,
                  args: [],
                  argumentBytes: 0,
                  closed: false,
                  ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
                };
              }
              continue;
            }
          } else if (event.type === "tool_call_delta") {
            if (pending) {
              const bytes = jsonStringPartsUtf8Bytes([event.arguments], TRANSLATOR_MAX_CALL_ARGUMENT_BYTES + 2) - 2;
              if (bytes > TRANSLATOR_MAX_CALL_ARGUMENT_BYTES - pending.argumentBytes) {
                throw new TranslatorBudgetExceededError("tool_args", TRANSLATOR_MAX_CALL_ARGUMENT_BYTES);
              }
              retention.retain(event);
              pending.argumentBytes += bytes;
              pending.args.push(event.arguments);
            }
            if (holdingCurrent) continue;
          } else if (event.type === "tool_call_end") {
            hasIncompleteToolCall ||= event.incomplete === true;
            if (pending) {
              retention.retain(event);
              pending.closed = !event.incomplete;
              if (pending.name === session.wireName) held.push(pending);
              pending = null;
            }
            if (holdingCurrent) {
              holdingCurrent = false;
              continue;
            }
          } else if (event.type === "done") {
            if (!hasRealToolCall) retention.retain(event);
            if (pending) { held.push(pending); pending = null; }
            terminalEvent = event;
            terminalConsumed = true;
            break;
          } else if (event.type === "incomplete" || event.type === "error") {
            pending = null;
            accumulatedUsage = mergeUsage(accumulatedUsage, event.usage);
            yield accumulatedUsage ? { ...event, usage: accumulatedUsage } : event;
            return;
          } else {
            if (event.type === "text_delta") {
              legTextChars += event.text.length;
              if (!hasRealToolCall && event.text !== "" && legTextChars <= MAX_LEG_TEXT_CHARS) {
                retention.retain(event, false, false);
                legEvents.push(event);
              }
            } else if (event.type === "thinking_delta") {
              legThinkingChars += event.thinking.length;
              if (!hasRealToolCall && event.thinking !== "" && legThinkingChars <= MAX_LEG_THINKING_CHARS) {
                retention.retain(event, false, false);
                legEvents.push(event);
              }
            } else if (event.type === "thinking_signature" || event.type === "redacted_thinking") {
              if (!hasRealToolCall) {
                retention.retain(event);
                legEvents.push(event);
              }
            }
          }
          yield event;
        }

        const searchCalls = held.filter(call => call.name === session.wireName && call.closed);
        const shouldIntercept = terminalConsumed
          && terminalEvent?.stopReason !== "max_tokens"
          && terminalEvent?.stopReason !== "content_filter"
          && searchCalls.length > 0
          && !hasRealToolCall
          && !hasIncompleteToolCall;

        if (!shouldIntercept) {
          if (terminalEvent) {
            accumulatedUsage = mergeUsage(accumulatedUsage, terminalEvent.usage);
            yield accumulatedUsage ? { ...terminalEvent, usage: accumulatedUsage } : terminalEvent;
          }
          return;
        }

        accumulatedUsage = mergeUsage(accumulatedUsage, terminalEvent?.usage);
        if (session.remainingTurns <= 0) {
          yield {
            type: "error",
            status: 502,
            errorType: "upstream_error",
            code: UNDECLARED_TOOL_CALL_ERROR_CODE,
            message: `gateway tool search exceeded ${GATEWAY_TOOL_SEARCH_MAX_TURNS} turns`,
            ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
          };
          return;
        }
        session.remainingTurns -= 1;

        const timestamp = Date.now();
        const assistantContent = assistantReplayContent(legEvents);
        const toolResults: EpxToolResultMessage[] = [];
        for (const call of searchCalls) {
          const parsedArgs = parseSearchArgs(call.args.join(""));
          const matched = searchDeferredTools(session.deferred, parsedArgs.query, parsedArgs.limit);
          for (const tool of matched) session.loaded.add(wireKeyForTool(tool));

          assistantContent.push({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: parsedArgs.query ? { query: parsedArgs.query, limit: parsedArgs.limit } : {},
            ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
          });

          const loadedSummary = matched.map(tool => ({
            name: wireKeyForTool(tool),
            description: tool.description,
          }));
          const contentText = JSON.stringify({
            loaded_tools: loadedSummary,
            loaded_count: loadedSummary.length,
            remaining_search_turns: session.remainingTurns,
          });
          toolResults.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: session.wireName,
            content: contentText,
            isError: false,
            timestamp,
          });
        }

        const messages: EpxMessage[] = [...parsed.context.messages];
        if (assistantContent.length > 0) {
          const assistantMsg: EpxAssistantMessage = {
            role: "assistant",
            content: assistantContent,
            timestamp,
          };
          messages.push(assistantMsg);
        }
        for (const tr of toolResults) {
          retention.history(jsonUtf8Bytes(tr.content) + jsonUtf8Bytes(tr.toolCallId) + 256, () => tr);
          messages.push(tr);
        }

        const nextTools = session.buildActiveTools(session.remainingTurns > 0);
        const choice = parsed.options.toolChoice;
        const resetSearchChoice = typeof choice === "object"
          && choice !== null
          && "name" in choice
          && choice.name === session.wireName;

        parsed = {
          ...parsed,
          context: {
            ...parsed.context,
            messages,
            tools: nextTools,
          },
          options: resetSearchChoice || (choice === "required" && nextTools.length === 0)
            ? { ...parsed.options, toolChoice: "auto" }
            : parsed.options,
        };

        held.length = legEvents.length = searchCalls.length = 0;
        pending = null;
        terminalEvent = undefined;
        retention.releaseLeg();
        yield { type: "assistant_boundary" };
        try {
          source = await options.continuation(parsed);
        } catch (error) {
          if (isTranslatorBudgetExceededError(error)) throw error;
          yield {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
          };
          return;
        }
      }
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      yield {
        type: "error",
        status: 502,
        errorType: "upstream_error",
        code: "translation_buffer_limit",
        message: "upstream translation buffer exceeded the safe limit",
        ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
      };
    } finally {
      retention.release();
    }
  };
}

/**
 * Installs gateway `defer_loading` (`epx_tool_search`) emulation onto `parsed` in place
 * for the initial request turn while leaving caller-owned `toolBridgeMaps` intact so
 * dynamically loaded deferred tools pass return-trip validation cleanly.
 */
export function installGatewayToolSearchEmulation(
  parsed: EpxParsedRequest,
  provider: Pick<EpxProviderConfig, "adapter" | "gatewayToolSearch">,
): boolean {
  if (!isGatewayToolSearchCandidate(parsed, provider)) return false;
  const session = createGatewayToolSearchSession(parsed);
  if (!session) return false;
  parsed.context = {
    ...parsed.context,
    tools: session.buildActiveTools(true),
  };
  parsed._gatewayToolSearchGuard = createGatewayToolSearchGuard(session);
  return true;
}
