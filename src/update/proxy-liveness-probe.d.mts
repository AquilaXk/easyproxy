/** Declaration for the plain-ESM liveness probe shared with `bin/epx.mjs`. */
export declare function probeProxyLiveness(
  port: number,
  hostname?: string,
  timeoutMs?: number,
): "live" | "dead" | "unknown";
