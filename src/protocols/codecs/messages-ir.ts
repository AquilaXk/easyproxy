import { messagesRolePresentation } from "../../lib/messages-error-body";
import { CLAUDE_CONTEXT_OVERFLOW_MESSAGE, markProxyError } from "../../lib/client-error-body";
/**
 * Anthropic Messages -> IR, directly (the Antigravity direct lane).
 *
 * The bridge decodes a Messages conversation twice: `anthropicToResponsesTranslation`
 * (`src/claude/inbound.ts`) projects it into Responses items, then `parseRequest`
 * (`src/responses/parser.ts`) turns those items into the IR. This module walks the Messages body
 * once and builds the IR conversation itself: the system prompt (including the
 * `stabilizePromptCache` relocation), user turns with images and documents, tool calls and
 * results (including `tool_reference` markers, tool errors and blocked-skill elision), thinking
 * and redacted thinking with their epxr1 envelopes, the native reasoning replay map, and the
 * tool catalog. It is the Messages twin of `chat-ir.ts`.
 *
 * Contract: for every Messages body the bridge accepts, `messagesConversationToIr(body, cc,
 * budget, model)` equals the `context` of `parseRequest(anthropicToResponsesTranslation(body,
 * cc).body)` (reasoning item ids are random on both sides), and every body the bridge refuses in
 * its conversation walk is refused here with the same `AnthropicRequestError` message.
 * `tests/responses/protocol-messages-ir-parity.test.ts` holds both sides over a fixture corpus.
 * Envelopes are encoded and charged against the request budget exactly as the translator does,
 * then decoded exactly as the parser does, so the signature an adapter reads is the same string.
 *
 * Request settings (model resolution, sampling, tool choice, format, prompt-cache key, reasoning)
 * are not decoded here: they travel through the Responses core on `anthropicSettingsTranslation`.
 * A hosted web-search tool never reaches this decoder: the lane's eligibility rule keeps it on the
 * bridge, where the sidecar reads it.
 */
import {
  anthropicDocumentData,
  anthropicImageBlockUrl,
  anthropicSystemLayout,
  blockedSkillCallIds,
  documentTitle,
  effectiveBlockedSkillNames,
  maybeElideSkillText,
  preservedAnthropicSystemBlocks,
  skillElisionStub,
  systemMessageText,
} from "../../claude/inbound";
import { parseEpxCacheControl, type EpxCacheControl } from "../cache-control";
import { toolsToResponses } from "../../claude/inbound-content-options";
import { AnthropicRequestError, isRec, type Rec } from "../../claude/inbound-records";
import { hasRoutedIdentity, nameRoutedIdentity } from "../../adapters/identity";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { inlineDocumentFromDataUrl, inlineDocumentMarker } from "../../responses/inline-document";
import { functionCallArgumentsFromText } from "../../responses/parser";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, EPX_REASONING_PREFIX } from "../../responses/reasoning-envelope";
import { normalizeVisualizationContext } from "../../responses/visualization-directives";
import type { PolicyRequestEvidence } from "../../routing/evaluator";
import { createToolChoiceResolver, namespacedToolName } from "../../types";
import type {
  EpxAssistantMessage,
  EpxClaudeCodeConfig,
  EpxContentPart,
  EpxContext,
  EpxMessage,
  EpxParsedRequest,
  EpxTextContent,
  EpxThinkingContent,
  EpxTool,
} from "../../types";
import { normalizedParameters } from "./chat-ir";

/** The translator refuses an undecodable proxy envelope with this message; the ingress retries it. */
export const MALFORMED_REASONING_SIGNATURE = "malformed epxr1 reasoning signature";

function nameDestination(text: string, modelId: string): string {
  return hasRoutedIdentity(text) ? nameRoutedIdentity(text, modelId) : text;
}

function reasoningItemId(): string {
  return `rs_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The parser collapses a lone text part without cache_control to a plain string; images, documents, and cached blocks stay structured. */
function collapsed(parts: EpxContentPart[]): string | EpxContentPart[] {
  return parts.length === 1 && parts[0]!.type === "text" && !parts[0]!.cacheControl ? parts[0]!.text : parts;
}

/** One entry of a tool result as the translator lists it, before the parser reads it. */
type ToolResultEntry = { text: string; cacheControl?: EpxCacheControl } | { image: string; cacheControl?: EpxCacheControl };

/**
 * A `tool_result` block's content as the IR carries it: the translator's `toolResultOutput`
 * (error prefix, `tool_reference` markers, image references, document markers) read through the
 * parser's `outputToToolResultContent` (text joined unless an image or block cache_control survives).
 */
function toolResultContent(block: Rec): string | EpxContentPart[] {
  const isError = block.is_error === true;
  const content = block.content;
  if (typeof content === "string") return isError ? `[tool error] ${content}` : content;
  if (!Array.isArray(content)) return isError ? "[tool error]" : "";
  const out: ToolResultEntry[] = [];
  for (const item of content) {
    if (!isRec(item)) continue;
    const itemCc = parseEpxCacheControl(item.cache_control);
    if (item.type === "text" && typeof item.text === "string") {
      out.push({ text: item.text, ...(itemCc ? { cacheControl: itemCc } : {}) });
    } else if (item.type === "tool_reference" && typeof item.tool_name === "string" && item.tool_name.length > 0) {
      const prev = out[out.length - 1];
      const lead = prev !== undefined && "text" in prev && !prev.text.endsWith("\n") ? "\n" : "";
      out.push({ text: `${lead}Tool loaded: ${item.tool_name}\n`, ...(itemCc ? { cacheControl: itemCc } : {}) });
    } else if (item.type === "image") {
      const url = anthropicImageBlockUrl(item);
      if (url !== null) out.push({ image: url, ...(itemCc ? { cacheControl: itemCc } : {}) });
    } else if (item.type === "document") {
      out.push({ text: inlineDocumentMarker(documentTitle(item)), ...(itemCc ? { cacheControl: itemCc } : {}) });
    }
  }
  if (isError) out.unshift({ text: "[tool error]" });
  if (out.length === 0) return isError ? "[tool error]" : "";
  const parts: EpxContentPart[] = [];
  let hasImageOrCache = false;
  for (const entry of out) {
    if (entry.cacheControl) hasImageOrCache = true;
    if ("text" in entry) parts.push({ type: "text", text: entry.text, ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}) });
    else if (entry.image.length > 0) {
      parts.push({ type: "image", imageUrl: entry.image, ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}) });
      hasImageOrCache = true;
    }
  }
  if (!hasImageOrCache) return parts.map(part => (part.type === "text" ? part.text : "")).join("");
  return parts;
}

/**
 * The tool catalog: the translator's function declarations (a hosted web-search tool and
 * schema-less server tools are not function tools) read through the parser's `buildTools` and
 * deduplicated by name as its catalog merge does.
 */
function toolCatalog(raw: unknown): EpxTool[] {
  if (!Array.isArray(raw)) return [];
  const declared: EpxTool[] = [];
  for (const entry of raw) {
    if (!isRec(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type.startsWith("web_search")) continue;
    if (typeof entry.name !== "string" || entry.name.length === 0 || !isRec(entry.input_schema)) continue;
    const tool: EpxTool = {
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      parameters: normalizedParameters(entry.input_schema),
      strict: typeof entry.strict === "boolean" ? entry.strict : false,
    };
    if (Array.isArray(entry.allowed_callers)) {
      tool.allowedCallers = entry.allowed_callers.filter((caller): caller is string => typeof caller === "string");
    }
    const cacheControl = parseEpxCacheControl(entry.cache_control);
    if (cacheControl) tool.cacheControl = cacheControl;
    declared.push(tool);
  }
  const seen = new Set<string>();
  return declared.filter(tool => {
    const key = namespacedToolName(tool.namespace, tool.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface MessagesIrConversation {
  /** The resolved model the conversation was decoded for; identity naming and placeholders use it. */
  modelId: string;
  context: EpxContext;
  /** The native reasoning blobs the translator would have recorded, keyed by blob. */
  nativeReasoningReplay: ReadonlyMap<string, string>;
}

/**
 * Decode a Messages body's conversation straight into the IR context. `modelId` is the resolved
 * model the bridge body would carry. Throws `AnthropicRequestError` exactly where the translator's
 * conversation walk would, and `TranslatorBudgetExceededError` where its envelope charges would.
 */
export function messagesConversationToIr(
  raw: unknown,
  cc: EpxClaudeCodeConfig | undefined,
  budget: TranslatorBudget,
  modelId: string,
): MessagesIrConversation {
  if (!isRec(raw)) throw markProxyError(new AnthropicRequestError("request body must be a JSON object"));
  if (typeof raw.model !== "string" || raw.model.length === 0) throw markProxyError(new AnthropicRequestError("model is required"));
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw markProxyError(new AnthropicRequestError("messages must be a non-empty array"));
  }
  const requestedModel = raw.model;
  const now = Date.now();
  const messages: EpxMessage[] = [];
  const nativeReasoningReplay = new Map<string, string>();
  const blockedNames = effectiveBlockedSkillNames(cc);
  const blockedCalls = blockedSkillCallIds(raw.messages, blockedNames);
  // The parser's pending reasoning: it belongs to the next assistant turn, and turn boundaries
  // clear it after keeping any signed or redacted replay.
  const pending: Array<{ part: EpxThinkingContent; envelopeSigned: boolean }> = [];

  const placeholder = (): EpxAssistantMessage => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") return last;
    const holder: EpxAssistantMessage = { role: "assistant", content: [], model: modelId, timestamp: now };
    messages.push(holder);
    return holder;
  };
  const holderWithReasoning = (): EpxAssistantMessage => {
    const holder = placeholder();
    if (pending.length > 0) {
      holder.content.push(...pending.map(entry => entry.part));
      pending.length = 0;
    }
    return holder;
  };
  const preservePendingReplay = (): void => {
    const replay = pending.filter(entry => entry.envelopeSigned || entry.part.redacted?.length);
    if (replay.length > 0) placeholder().content.push(...replay.map(entry => entry.part));
  };
  const pushUser = (content: string | EpxContentPart[]): void => {
    preservePendingReplay();
    pending.length = 0;
    messages.push({ role: "user", content, timestamp: now });
  };
  const pushDeveloper = (text: string): void => {
    preservePendingReplay();
    pending.length = 0;
    messages.push({ role: "developer", content: nameDestination(text, modelId), timestamp: now });
  };
  const pushAssistantText = (parts: EpxTextContent[]): void => {
    messages.push({
      role: "assistant",
      content: pending.length > 0 ? [...pending.map(entry => entry.part), ...parts] : parts,
      model: modelId,
      timestamp: now,
    });
    pending.length = 0;
  };
  const pushToolCall = (id: string, name: string, input: unknown, cacheControl?: EpxCacheControl): void => {
    holderWithReasoning().content.push({
      type: "toolCall",
      id,
      name,
      arguments: functionCallArgumentsFromText(id, JSON.stringify(input ?? {})),
      ...(cacheControl ? { cacheControl } : {}),
    });
  };
  const pushToolResult = (callId: string, content: string | EpxContentPart[], cacheControl?: EpxCacheControl): void => {
    // Reasoning replayed after the call it belongs to joins that call's assistant turn (#950).
    if (pending.length > 0) {
      outer: for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.role !== "assistant") continue;
        for (const part of message.content) {
          if (part.type === "toolCall" && part.id === callId) {
            message.content = [...pending.map(entry => entry.part), ...message.content];
            break outer;
          }
        }
      }
    }
    pending.length = 0;
    let owner: { name: string; namespace?: string } = { name: "" };
    search: for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "toolCall" && part.id === callId) {
          owner = { name: part.name, namespace: part.namespace };
          break search;
        }
      }
    }
    messages.push({
      role: "toolResult", toolCallId: callId, toolName: owner.name, toolNamespace: owner.namespace,
      content, isError: false, timestamp: now,
      ...(cacheControl ? { cacheControl } : {}),
    });
  };
  /**
   * One translator reasoning item, read as the parser reads it. `encrypted` is the item's
   * `encrypted_content`; the placeholder signature is the item's serialized form, spelled in the
   * schema's key order.
   */
  const pushReasoning = (id: string, summaryText: string, encrypted: string | undefined, cacheControl?: EpxCacheControl): void => {
    const item: Rec = {
      type: "reasoning",
      id,
      summary: summaryText.length > 0 ? [{ type: "summary_text", text: summaryText }] : [],
      ...(encrypted !== undefined ? { encrypted_content: encrypted } : {}),
      ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
    };
    const envelope = encrypted !== undefined ? decodeReasoningEnvelope(encrypted) : null;
    const thinkingText = envelope?.txt ?? summaryText;
    if (envelope?.krc && thinkingText.length === 0) {
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") previous.kiroRedactedReasoning = envelope.krc;
      return;
    }
    if (!(thinkingText.length > 0 || envelope?.sig || envelope?.red?.length)) return;
    const part: EpxThinkingContent = {
      type: "thinking",
      thinking: thinkingText,
      signature: envelope?.sig ?? JSON.stringify(item),
      ...(envelope?.red ? { redacted: envelope.red } : {}),
      itemId: id,
      ...(cacheControl ? { cacheControl } : {}),
    };
    const envelopeSigned = typeof envelope?.sig === "string";
    const previous = pending[pending.length - 1];
    if (!envelopeSigned && !part.redacted && previous && !previous.envelopeSigned && !previous.part.redacted) {
      previous.part = { ...part, thinking: `${previous.part.thinking}\n${part.thinking}` };
    } else {
      pending.push({ part, envelopeSigned });
    }
  };

  const userContent = (content: unknown): void => {
    if (typeof content === "string") {
      if (content.length > 0) pushUser(content);
      return;
    }
    if (!Array.isArray(content)) return;
    // Contiguous text, image and document blocks form one user turn; a tool_result ends it.
    let parts: EpxContentPart[] = [];
    let blocks = 0;
    const flush = (): void => {
      if (blocks > 0) pushUser(collapsed(parts));
      parts = [];
      blocks = 0;
    };
    for (const block of content) {
      if (!isRec(block)) continue;
      const blockCc = parseEpxCacheControl(block.cache_control);
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") {
            blocks++;
            parts.push({
              type: "text",
              text: maybeElideSkillText(block.text, blockedNames),
              ...(blockCc ? { cacheControl: blockCc } : {}),
            });
          }
          break;
        case "image": {
          const url = anthropicImageBlockUrl(block);
          if (url !== null) {
            blocks++;
            // An empty reference is a block the parser drops.
            if (url.length > 0) parts.push({ type: "image", imageUrl: url, ...(blockCc ? { cacheControl: blockCc } : {}) });
          }
          break;
        }
        case "tool_result": {
          flush();
          if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
            throw markProxyError(new AnthropicRequestError("tool_result requires tool_use_id"));
          }
          pushToolResult(
            block.tool_use_id,
            blockedCalls.has(block.tool_use_id) ? skillElisionStub(block.tool_use_id) : toolResultContent(block),
            blockCc,
          );
          break;
        }
        case "document": {
          blocks++;
          const document = anthropicDocumentData(block);
          const docPart = document
            ? inlineDocumentFromDataUrl(document.fileData, document.title)
              ?? { type: "text" as const, text: document.title ? `[file: ${document.title}]` : "[file: inline data]" }
            : { type: "text" as const, text: inlineDocumentMarker(documentTitle(block)) };
          parts.push(blockCc ? { ...docPart, cacheControl: blockCc } : docPart);
          break;
        }
        default:
          break;
      }
    }
    flush();
  };

  const assistantContent = (content: unknown): void => {
    if (typeof content === "string") {
      if (content.length > 0) pushAssistantText([{ type: "text", text: content }]);
      return;
    }
    if (!Array.isArray(content)) return;
    let text: EpxTextContent[] = [];
    const flush = (): void => {
      if (text.length > 0) pushAssistantText(text);
      text = [];
    };
    for (const block of content) {
      if (!isRec(block)) continue;
      const blockCc = parseEpxCacheControl(block.cache_control);
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") text.push({ type: "text", text: block.text, ...(blockCc ? { cacheControl: blockCc } : {}) });
          break;
        case "tool_use":
          flush();
          if (typeof block.id !== "string" || block.id.length === 0 || typeof block.name !== "string" || block.name.length === 0) {
            throw markProxyError(new AnthropicRequestError("tool_use requires id and name"));
          }
          pushToolCall(block.id, block.name, block.input, blockCc);
          break;
        case "thinking": {
          flush();
          const thinking = typeof block.thinking === "string" ? block.thinking : "";
          const signature = typeof block.signature === "string" ? block.signature : "";
          if (signature.startsWith(EPX_REASONING_PREFIX)) {
            const owned = decodeReasoningEnvelope(signature, budget);
            if (!owned) throw markProxyError(new AnthropicRequestError(MALFORMED_REASONING_SIGNATURE));
            if (Object.hasOwn(owned, "sig")) {
              throw markProxyError(new AnthropicRequestError("EasyProxy reasoning continuity cannot be replayed as an Anthropic signature"));
            }
            if (owned.nat) {
              // The provider's own blob goes back only to the model that minted it.
              const nat = owned.nat.model === requestedModel ? owned.nat : undefined;
              if (nat) {
                const previous = nativeReasoningReplay.get(nat.enc);
                nativeReasoningReplay.set(nat.enc, previous === undefined || previous === nat.tag ? nat.tag : "");
                budget.chargeRetained(2 * nat.enc.length, { kind: "reasoning" });
              }
              if (thinking.length === 0 && !nat) break;
              pushReasoning(nat?.id ?? reasoningItemId(), thinking, nat?.enc, blockCc);
              break;
            }
          }
          const encrypted = signature.length === 0
            ? undefined
            : signature.startsWith(EPX_REASONING_PREFIX) ? signature : encodeReasoningEnvelope({ sig: signature }, budget);
          if (encrypted) budget.chargeRetained(2 * encrypted.length, { kind: "reasoning" });
          if (thinking.length === 0 && !encrypted) break;
          pushReasoning(reasoningItemId(), thinking, encrypted, blockCc);
          break;
        }
        case "redacted_thinking": {
          flush();
          const data = typeof block.data === "string" ? block.data : "";
          if (data.length > 0) {
            const encrypted = encodeReasoningEnvelope({ red: [data] }, budget);
            budget.chargeRetained(2 * encrypted.length, { kind: "reasoning" });
            pushReasoning(reasoningItemId(), "", encrypted);
          }
          break;
        }
        default:
          break;
      }
    }
    flush();
  };

  for (const message of raw.messages) {
    if (!isRec(message)) throw markProxyError(new AnthropicRequestError("each message must be an object"));
    if (message.role === "user") userContent(message.content);
    else if (message.role === "assistant") assistantContent(message.content);
    else if (message.role === "system") {
      const text = systemMessageText(message.content);
      if (text.length > 0) pushDeveloper(text);
    } else {
      const role = messagesRolePresentation(message.role);
      if (role.coercionFailed) throw markProxyError(new TypeError("unsupported message role: unsupported"));
      throw markProxyError(new AnthropicRequestError(role.overflow ? CLAUDE_CONTEXT_OVERFLOW_MESSAGE : "unsupported message role: unsupported"));
    }
  }

  const system = anthropicSystemLayout(raw.system, cc);
  const systemBlocks = preservedAnthropicSystemBlocks(raw.system, system, cc);
  const systemCacheControls = systemBlocks?.map(b => b.cache_control);
  if (system.dynamicNotice !== undefined) pushUser(system.dynamicNotice);
  preservePendingReplay();

  const tools = toolCatalog(raw.tools);
  const context: EpxContext = {
    ...(systemBlocks
      ? {
          systemPrompt: systemBlocks.map(b => nameDestination(b.text, modelId)),
          ...(systemCacheControls?.some(c => c !== undefined) ? { systemCacheControls } : {}),
        }
      : system.instructions
        ? { systemPrompt: [nameDestination(system.instructions, modelId)] }
        : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
  return { modelId, context: normalizeVisualizationContext(context), nativeReasoningReplay };
}

/**
 * Put a directly decoded conversation onto the request the core parsed from the settings-only
 * body, re-decoding if the core settled a different model id than the one decoded for. The tool
 * choice is checked against the decoded catalog, which the settings-only parse could not see.
 */
export function withDirectMessagesConversation(
  base: EpxParsedRequest,
  decoded: MessagesIrConversation,
  decodeFor: (modelId: string) => MessagesIrConversation,
): EpxParsedRequest {
  const conversation = decoded.modelId === base.modelId ? decoded : decodeFor(base.modelId);
  const choice = base.options.toolChoice;
  if (choice && typeof choice === "object") {
    const selectors = "allowedTools" in choice ? choice.allowedTools : [choice.name];
    const resolver = createToolChoiceResolver(conversation.context.tools ?? []);
    for (const selector of selectors) {
      if (resolver.candidateCount(selector) > 1) throw new Error(`ambiguous tool_choice name: ${selector}`);
    }
  }
  return { ...base, context: conversation.context };
}

/**
 * The policy-routing evidence the core reads from the bridge body (`evidenceFromBody`): a
 * non-empty translated tool catalog, and an image block in a user turn. Images inside a
 * tool_result sit under `output` on the bridge body, which that scan does not read.
 */
export function messagesRouteEvidence(raw: unknown): PolicyRequestEvidence {
  if (!isRec(raw)) return {};
  const tools = toolsToResponses(raw.tools) !== undefined;
  const image = Array.isArray(raw.messages) && raw.messages.some(message => isRec(message)
    && message.role === "user" && Array.isArray(message.content)
    && message.content.some(block => isRec(block) && block.type === "image" && imageReference(block)));
  return {
    ...(tools ? { toolsRequired: true } : {}),
    ...(image ? { imageInputRequired: true } : {}),
  };
}

function imageReference(block: Rec): boolean {
  try {
    return anthropicImageBlockUrl(block) !== null;
  } catch {
    return false;
  }
}

