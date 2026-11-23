import { assertJsonNestingDepth, JsonNestingDepthExceededError } from "../lib/json-depth-guard";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { ResponseBodyInactivityError } from "../lib/response-body-inactivity";
import { TRANSLATOR_MAX_TURN_BYTES } from "../lib/translator-budget";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { AdapterEvent } from "../types";

export class UpstreamResponseTooLargeError extends Error {
  readonly code = "upstream_response_too_large";

  constructor(readonly limitBytes: number) {
    super(`upstream response exceeded ${limitBytes} bytes`);
    this.name = "UpstreamResponseTooLargeError";
  }
}

export function upstreamJsonErrorEvent(error: unknown, fallbackMessage: string): Extract<AdapterEvent, { type: "error" }> {
  const message = error instanceof UpstreamResponseTooLargeError || error instanceof JsonNestingDepthExceededError
    ? error.message
    : fallbackMessage;
  return {
    type: "error",
    message,
    status: 502,
    errorType: "upstream_error",
  };
}

/**
 * Re-throw body inactivity timeouts so response delivery classifies stalls as 504,
 * while converting size, nesting, and parse errors to unparseable 502 adapter events.
 */
export function handleBoundedUpstreamJsonError(
  error: unknown,
  tierMetadata: AdapterTierMetadata | undefined,
  fallbackMessage: string,
): [Extract<AdapterEvent, { type: "error" }>] {
  if (error instanceof ResponseBodyInactivityError) throw error;
  tierMetadata?.markResponseUnparseable();
  return [upstreamJsonErrorEvent(error, fallbackMessage)];
}

/**
 * Consume a non-streaming upstream JSON response under strict byte and nesting
 * depth bounds before JSON.parse materializes an object graph.
 */
export async function readBoundedUpstreamJson(
  response: Response,
  maxBytes: number = TRANSLATOR_MAX_TURN_BYTES,
): Promise<{ parsed: unknown; byteLength: number }> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength !== null) {
    const contentLength = Number(rawContentLength.trim());
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore stream cancellation failures from an already-broken body.
      }
      throw new UpstreamResponseTooLargeError(maxBytes);
    }
  }
  const { bytes, oversized } = await readBoundedResponseBytes(response, { maxBytes });
  if (oversized) {
    throw new UpstreamResponseTooLargeError(maxBytes);
  }
  assertJsonNestingDepth(bytes);
  const text = new TextDecoder().decode(bytes);
  return {
    parsed: JSON.parse(text) as unknown,
    byteLength: bytes.byteLength,
  };
}
