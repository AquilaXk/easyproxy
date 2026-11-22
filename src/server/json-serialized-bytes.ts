import { Buffer } from "node:buffer";

type Frame =
  | { items: readonly unknown[]; index: number }
  | { record: Record<string, unknown>; keys: readonly string[]; index: number; emitted: boolean };

// Extra bytes beyond 1 UTF-16 code unit for ASCII bytes 0x00..0x7f inside JSON strings:
// control bytes expand to \u00XX (+5) except \b/\t/\n/\f/\r (+1); quote (") & backslash (\) (+1).
const JSON_ASCII_EXTRA = (() => {
  const table = new Uint8Array(128);
  table.fill(5, 0, 0x20);
  table[0x08] = 1; // \b
  table[0x09] = 1; // \t
  table[0x0a] = 1; // \n
  table[0x0c] = 1; // \f
  table[0x0d] = 1; // \r
  table[0x22] = 1; // "
  table[0x5c] = 1; // \
  return table;
})();

function jsonStringSerializedBytes(str: string): number {
  const len = str.length;
  let bytes = 2 + len;
  for (let i = 0; i < len; i += 1) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes += JSON_ASCII_EXTRA[c]!;
    } else if (c < 0x800) {
      bytes += 1;
    } else if ((c & 0xfc00) === 0xd800) {
      if (i + 1 < len && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        bytes += 2;
        i += 1;
      } else {
        bytes += 5;
      }
    } else if ((c & 0xfc00) === 0xdc00) {
      bytes += 5;
    } else {
      bytes += 2;
    }
  }
  return bytes;
}

function resolveToJson(value: unknown, key: string): unknown {
  if (value !== null && (typeof value === "object" || typeof value === "bigint")) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return (toJson as (k: string) => unknown).call(value, key);
    }
  }
  return value;
}

/**
 * UTF-8 byte length of JSON.stringify(value) for a JSON.parse result, computed without
 * recursion or per-primitive JSON.stringify allocations.
 */
export function serializedJsonByteLength(value: unknown): number {
  const root = resolveToJson(value, "");
  if (root === undefined || typeof root === "function" || typeof root === "symbol") {
    return 0;
  }
  let bytes = 0;
  const stack: Frame[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      bytes += jsonStringSerializedBytes(item);
    } else if (item === null || item === undefined || typeof item === "symbol" || typeof item === "function") {
      bytes += 4;
    } else if (typeof item === "boolean") {
      bytes += item ? 4 : 5;
    } else if (typeof item === "number") {
      bytes += Number.isFinite(item) ? (Object.is(item, -0) ? 1 : String(item).length) : 4;
    } else if (typeof item === "bigint") {
      bytes += Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    } else if (Array.isArray(item)) {
      bytes += 2 + (item.length > 0 ? item.length - 1 : 0);
      stack.push({ items: item, index: 0 });
    } else {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      bytes += 2;
      stack.push({ record, keys, index: 0, emitted: false });
    }
  };
  visit(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if ("items" in frame) {
      if (frame.index < frame.items.length) {
        const idx = frame.index++;
        visit(resolveToJson(frame.items[idx], String(idx)));
      } else {
        stack.pop();
      }
    } else {
      let pushedOrHandled = false;
      while (frame.index < frame.keys.length) {
        const key = frame.keys[frame.index++]!;
        const propVal = resolveToJson(frame.record[key], key);
        if (propVal === undefined || typeof propVal === "function" || typeof propVal === "symbol") {
          continue;
        }
        if (frame.emitted) bytes += 1;
        else frame.emitted = true;
        bytes += jsonStringSerializedBytes(key) + 1;
        visit(propVal);
        pushedOrHandled = true;
        break;
      }
      if (!pushedOrHandled) {
        stack.pop();
      }
    }
  }
  return bytes;
}
