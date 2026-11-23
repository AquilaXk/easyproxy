// Zero-import single-consume cache so passthrough dispatch avoids re-parsing
// the JSON string immediately after the Responses adapter serializes it.

interface TransientWireEntry {
  serialized: string;
  wireBody: Record<string, unknown>;
}

const transientWireBodies = new WeakMap<object, TransientWireEntry>();

/** Bind an already-serialized plain wire body to its AdapterRequest for one read. */
export function rememberTransientOutboundWireBody(
  request: object,
  serialized: string,
  wireBody: Record<string, unknown>,
): void {
  transientWireBodies.set(request, { serialized, wireBody });
}

/**
 * Consume and return the remembered wire body iff `serialized` matches byte-for-byte.
 * Always deletes any entry for `request` so full bodies are never retained across turns.
 */
export function takeTransientOutboundWireBody(
  request: object | undefined,
  serialized: string,
): Record<string, unknown> | undefined {
  if (!request) return undefined;
  const entry = transientWireBodies.get(request);
  if (!entry) return undefined;
  transientWireBodies.delete(request);
  return entry.serialized === serialized ? entry.wireBody : undefined;
}
