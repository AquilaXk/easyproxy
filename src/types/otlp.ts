export interface EpxOtlpConfig {
  /** Master switch. Default false (disabled with O(1) zero-overhead runtime check). */
  enabled: boolean;
  /** Target OTLP/HTTP trace collector endpoint (e.g. https://collector/v1/traces or loopback http://). */
  endpoint?: string;
  /** Optional static headers (e.g. Authorization / collector API key), masked on management/CLI output. */
  headers?: Record<string, string>;
  /** Optional OTLP resource service.name (default "easyproxy"). */
  serviceName?: string;
  /** Trace sampling rate in [0, 1] (default 1). */
  sampleRate?: number;
  /** Per-export HTTP timeout in milliseconds (500..30000, default 5000). */
  timeoutMs?: number;
  /** Bounded in-memory queue capacity (16..4096, default 512). */
  maxQueueSize?: number;
  /** Maximum spans per OTLP batch (1..256, default 64). */
  batchSize?: number;
  /** Allow private-network http:// endpoints when true; metadata destinations remain blocked. */
  allowPrivateNetwork?: boolean;
}
