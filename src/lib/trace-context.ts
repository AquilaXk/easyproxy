/** Inject W3C traceparent onto mutable outbound header records without overriding an explicit value. */
export function injectOtlpTraceparent(headers: Record<string, string>, traceparent?: string): void {
  if (!traceparent) return;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "traceparent") return;
  }
  headers.traceparent = traceparent;
}
