/*
 * Adapted from can1357/oh-my-pi (packages/ai/src/providers/openai-configuration-update.ts),
 * licensed under the MIT License.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isOpenAiOperatedResponsesDestination } from "../../providers/openai-tiers";
import type { EpxParsedRequest, EpxProviderConfig } from "../../types";
import type { IncomingMeta } from "../base";
import { destinationHostOfUrl, isConfigurationUpdateUnsupportedMemoized } from "./config-update-fallback";
import { isPlainObject } from "./internal";

const SESSION_KEY_HMAC = randomBytes(32);

export const MAX_OPENAI_EFFORT_SESSIONS = 128;
export const MAX_OPENAI_EFFORT_TRANSITIONS = 64;
export const OPENAI_EFFORT_SESSION_TTL_MS = 60 * 60 * 1000;

export interface ConfigurationUpdateItem {
  type: "configuration_update";
  reasoning: { effort: string };
}

export interface OpenAIEffortTransition {
  index: number;
  anchor: string;
  effort: string;
}

export interface OpenAIEffortControlState {
  sessionId: string;
  baseEffort: string | undefined;
  currentEffort: string | undefined;
  transitions: OpenAIEffortTransition[];
  updatedAt: number;
}

const sessions = new Map<string, OpenAIEffortControlState>();

export function resetOpenAIEffortControlStoreForTests(): void {
  sessions.clear();
}

export function openAIEffortControlStoreSizeForTests(): number {
  return sessions.size;
}

function stableHash(value: string): string {
  return createHmac("sha256", SESSION_KEY_HMAC).update(value).digest("hex").slice(0, 32);
}

function sweepSessions(now: number): void {
  for (const [key, entry] of sessions) {
    if (now - entry.updatedAt > OPENAI_EFFORT_SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
}

function getOrCreateSessionState(scopeKey: string, now: number): OpenAIEffortControlState {
  sweepSessions(now);
  const existing = sessions.get(scopeKey);
  if (existing) {
    sessions.delete(scopeKey);
    existing.updatedAt = now;
    sessions.set(scopeKey, existing);
    return existing;
  }
  const fresh: OpenAIEffortControlState = {
    sessionId: scopeKey,
    baseEffort: undefined,
    currentEffort: undefined,
    transitions: [],
    updatedAt: now,
  };
  sessions.set(scopeKey, fresh);
  while (sessions.size > MAX_OPENAI_EFFORT_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return fresh;
}

function resetState(state: OpenAIEffortControlState): void {
  state.baseEffort = undefined;
  state.currentEffort = undefined;
  state.transitions = [];
}

/**
 * Fingerprint of the item a transition sits after. Output-only lifecycle
 * fields (`id`, `status`) are excluded so live vs sanitized history replay matches.
 */
function effortControlAnchor(input: readonly unknown[], index: number): string {
  if (index === 0) return "";
  const item = input[index - 1];
  if (!isPlainObject(item)) return "";
  const { id: _id, status: _status, ...stable } = item;
  return stableHash(JSON.stringify(stable));
}

function syncState(state: OpenAIEffortControlState, input: readonly unknown[]): void {
  for (const transition of state.transitions) {
    if (transition.index > input.length || transition.anchor !== effortControlAnchor(input, transition.index)) {
      resetState(state);
      return;
    }
  }
}

/**
 * Plan baseline request-level `reasoning.effort` + splice any mid-conversation
 * `configuration_update` transitions into `input` (mutated in place).
 */
export function planStableOpenAIEffort(
  state: OpenAIEffortControlState,
  input: Array<unknown>,
  requested: string,
): string {
  syncState(state, input);
  if (state.baseEffort === undefined) {
    state.baseEffort = requested;
    state.currentEffort = requested;
    return requested;
  }
  if (state.currentEffort !== requested) {
    const last = input[input.length - 1];
    const index = isPlainObject(last) && last.role === "user" ? input.length - 1 : input.length;
    const existing = state.transitions.find(transition => transition.index === index);
    if (existing) {
      existing.effort = requested;
    } else if (state.transitions.length < MAX_OPENAI_EFFORT_TRANSITIONS) {
      state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort: requested });
    } else {
      // Bounded transition table exhausted; rebase cleanly from this request's effort.
      resetState(state);
      state.baseEffort = requested;
      state.currentEffort = requested;
      return requested;
    }
    let preceding = state.baseEffort;
    let precedingIndex = -1;
    for (const transition of state.transitions) {
      if (transition.index < index && transition.index > precedingIndex) {
        preceding = transition.effort;
        precedingIndex = transition.index;
      }
    }
    if (requested === preceding) {
      state.transitions = state.transitions.filter(transition => transition.index !== index);
    }
    state.currentEffort = requested;
  }
  state.transitions.sort((a, b) => a.index - b.index);
  let offset = 0;
  for (const transition of state.transitions) {
    input.splice(transition.index + offset, 0, {
      type: "configuration_update",
      reasoning: { effort: transition.effort },
    } satisfies ConfigurationUpdateItem);
    offset += 1;
  }
  return state.baseEffort;
}

function conversationIdentity(parsed: EpxParsedRequest, body: Record<string, unknown>, incoming?: IncomingMeta): string | undefined {
  const promptCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()
    ? body.prompt_cache_key.trim()
    : undefined;
  const headerSession = incoming?.headers?.get("session_id")?.trim()
    || incoming?.headers?.get("x-claude-code-session-id")?.trim()
    || incoming?.headers?.get("thread-id")?.trim();
  const internalSession = parsed._codexOwnThreadId?.trim() || parsed._clientThreadId?.trim();
  return internalSession || headerSession || promptCacheKey;
}

export interface OpenAIPerMessageEffortBuild {
  provider: EpxProviderConfig;
  parsed: EpxParsedRequest;
  incoming?: IncomingMeta;
  body: Record<string, unknown>;
  url: string;
  now?: number;
}

/**
 * Cache-preserving `configuration_update` effort injector for OpenAI-operated Responses routes.
 * Opt-in via `provider.perMessageEffort === true`; returns a cloned body when mutated or leaves
 * the input body untouched on no-op/unsupported/stateless paths.
 */
export function applyOpenAIResponsesPerMessageEffort(build: OpenAIPerMessageEffortBuild): Record<string, unknown> {
  const { provider, parsed, incoming, body, url, now = Date.now() } = build;
  if (provider.perMessageEffort !== true || !isOpenAiOperatedResponsesDestination(provider)) return body;
  if (parsed._compactionRequest === true || parsed._stripConfigurationUpdateItems === true) return body;
  const host = destinationHostOfUrl(url);
  if (isConfigurationUpdateUnsupportedMemoized(host, parsed.modelId, now)) return body;
  if (typeof body.previous_response_id === "string" && body.previous_response_id.trim()) return body;
  if (!Array.isArray(body.input) || !isPlainObject(body.reasoning) || typeof body.reasoning.effort !== "string") {
    return body;
  }
  const requestedEffort = body.reasoning.effort.trim();
  if (!requestedEffort) return body;
  // Preserve caller-managed configuration_update items untouched.
  if (body.input.some(item => isPlainObject(item) && item.type === "configuration_update")) return body;
  const sessionKey = conversationIdentity(parsed, body, incoming);
  if (!sessionKey) return body;
  const scopeKey = stableHash(JSON.stringify([
    sessionKey,
    incoming?.providerName ?? "",
    host ?? "",
    typeof body.model === "string" ? body.model : parsed.modelId,
    provider.authMode ?? "key",
    typeof provider.apiKey === "string" && provider.apiKey ? stableHash(provider.apiKey) : "",
  ]));
  const state = getOrCreateSessionState(scopeKey, now);
  if (parsed._codexNewHistory === true) resetState(state);
  const nextInput = [...body.input];
  const anchorEffort = planStableOpenAIEffort(state, nextInput, requestedEffort);
  if (nextInput.length === body.input.length && anchorEffort === requestedEffort) {
    return body;
  }
  return {
    ...body,
    input: nextInput,
    reasoning: { ...body.reasoning, effort: anchorEffort },
  };
}
