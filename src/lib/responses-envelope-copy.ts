import { isPlainObject } from "./plain-data";

export interface ResponsesEnvelopeCopyOptions {
  /** Copy top-level `tools` array wrapper without cloning tool schemas. */
  shallowCopyToolsArray?: boolean;
  /** Shallow-copy ordinary `input` items so item-level property writes do not leak. */
  shallowCopyInputItems?: boolean;
}

const MUTABLE_TOP_LEVEL_OBJECTS = ["reasoning", "text", "client_metadata"] as const;

function hasEncryptedContentPart(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const part = value[i];
    if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "encrypted_content") {
      return true;
    }
  }
  return false;
}

function messageHasSkillsInstructions(item: Record<string, unknown>): boolean {
  if (item.type !== undefined && item.type !== "message") return false;
  if (item.role !== "developer" && item.role !== "system") return false;
  const content = item.content;
  if (typeof content === "string") return content.includes("<skills_instructions>");
  if (!Array.isArray(content)) return false;
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (part !== null && typeof part === "object") {
      const rec = part as { type?: unknown; text?: unknown };
      if ((rec.type === "text" || rec.type === "input_text") && typeof rec.text === "string"
        && rec.text.includes("<skills_instructions>")) {
        return true;
      }
    }
  }
  return false;
}

function cloneInputItem(item: unknown, shallowCopyOrdinary: boolean): unknown {
  if (item === null || typeof item !== "object") return item;
  if (Array.isArray(item)) return structuredClone(item);
  const record = item as Record<string, unknown>;
  if (
    record.type === "agent_message"
    || "encrypted_content" in record
    || hasEncryptedContentPart(record.content)
    || hasEncryptedContentPart(record.output)
    || messageHasSkillsInstructions(record)
  ) {
    return structuredClone(record);
  }
  return shallowCopyOrdinary ? { ...record } : item;
}

/**
 * Targeted envelope copy for Responses bodies, replacing full `structuredClone`.
 * Copies the top-level object, mutated sub-objects (`reasoning`, `text`, `client_metadata`),
 * and the `input` array while deep-cloning only items that downstream preparation mutates in place
 * (`agent_message`, `encrypted_content`-carrying items, and `<skills_instructions>` slots).
 * Immutable subtrees (`tools` schemas, `instructions`, `metadata`, ordinary input content) stay shared.
 */
export function cloneResponsesRequestEnvelope(
  body: unknown,
  options?: ResponsesEnvelopeCopyOptions,
): unknown {
  if (body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return structuredClone(body);
  const source = body as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...source };
  for (const key of MUTABLE_TOP_LEVEL_OBJECTS) {
    const sub = source[key];
    if (isPlainObject(sub)) copy[key] = { ...sub };
  }
  if (options?.shallowCopyToolsArray && Array.isArray(source.tools)) {
    copy.tools = [...source.tools];
  }
  if (Array.isArray(source.input)) {
    const shallowItems = options?.shallowCopyInputItems === true;
    const len = source.input.length;
    const nextInput = new Array<unknown>(len);
    for (let i = 0; i < len; i += 1) {
      nextInput[i] = cloneInputItem(source.input[i], shallowItems);
    }
    copy.input = nextInput;
  }
  return copy;
}
