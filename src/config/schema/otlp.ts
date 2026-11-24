import * as z from "zod/v4";
import { assessUrlDestination, providerDestinationConfigError } from "../../lib/destination-policy";

const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_OR_NEWLINE_RE = /[\r\n\u0000]/;
export const MAX_OTLP_HEADERS = 16;
export const MAX_OTLP_HEADER_VALUE_LEN = 1024;
export const MAX_OTLP_SERVICE_NAME_LEN = 128;

export function otlpEndpointConfigError(
  endpoint: unknown,
  allowPrivateNetwork = false,
): string | null {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    return "endpoint must be a non-empty http:// (loopback/private) or https:// URL";
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    return "endpoint must be a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "endpoint must use http:// or https://";
  }
  if (parsed.username || parsed.password) {
    return "endpoint URL must not contain embedded credentials";
  }
  const assessment = assessUrlDestination(endpoint);
  if (assessment?.kind === "metadata") {
    return "endpoint targets a blocked metadata endpoint";
  }
  let isLoopback = false;
  if (parsed.protocol === "http:") {
    isLoopback = assessment?.kind === "loopback" || assessment?.kind === "localhost";
    const isAllowedPrivate = assessment?.kind === "private" && allowPrivateNetwork === true;
    if (!isLoopback && !isAllowedPrivate) {
      return "http:// OTLP endpoints are restricted to loopback addresses (or private networks when allowPrivateNetwork is true); use https:// for remote collectors";
    }
  }
  return providerDestinationConfigError("__otlp__", {
    baseUrl: endpoint,
    allowPrivateNetwork: isLoopback || allowPrivateNetwork === true,
  });
}

export const otlpHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const entries = Object.entries(headers);
  if (entries.length > MAX_OTLP_HEADERS) {
    ctx.addIssue({ code: "custom", message: `at most ${MAX_OTLP_HEADERS} OTLP headers allowed` });
    return;
  }
  for (const [name, value] of entries) {
    if (!VALID_HEADER_NAME_RE.test(name) || name.length > 128) {
      ctx.addIssue({ code: "custom", path: [name], message: "invalid HTTP header name" });
    }
    if (CONTROL_OR_NEWLINE_RE.test(value) || value.length > MAX_OTLP_HEADER_VALUE_LEN) {
      ctx.addIssue({ code: "custom", path: [name], message: "invalid or oversized HTTP header value" });
    }
  }
});

export const otlpConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().trim().min(1).max(2048).optional(),
  headers: otlpHeadersSchema.optional(),
  serviceName: z.string().trim().min(1).max(MAX_OTLP_SERVICE_NAME_LEN).optional(),
  sampleRate: z.number().finite().min(0).max(1).optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
  maxQueueSize: z.number().int().min(16).max(4096).optional(),
  batchSize: z.number().int().min(1).max(256).optional(),
  allowPrivateNetwork: z.boolean().optional(),
}).strict().superRefine((cfg, ctx) => {
  if (cfg.endpoint !== undefined) {
    const err = otlpEndpointConfigError(cfg.endpoint, cfg.allowPrivateNetwork === true);
    if (err) ctx.addIssue({ code: "custom", path: ["endpoint"], message: err });
  } else if (cfg.enabled) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "endpoint is required when OTLP tracing is enabled" });
  }
});
