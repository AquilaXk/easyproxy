const LOOPBACK_AUDIO_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function audioDefaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

/**
 * Keep loopback `localhost` vs `127.0.0.1` aligned with the active page origin for browser requests
 * and WebSockets so `connect-src 'self'` allows live voice & dictation when served on either host.
 */
export function resolveAudioBrowserEndpoint(endpoint: string): string {
  if (typeof window === "undefined" || !window.location?.origin) return endpoint;
  try {
    const page = new URL(window.location.href);
    const target = new URL(endpoint);
    if (!LOOPBACK_AUDIO_HOSTS.has(page.hostname.toLowerCase()) || !LOOPBACK_AUDIO_HOSTS.has(target.hostname.toLowerCase())) {
      return endpoint;
    }
    const pageSecure = page.protocol === "https:";
    const targetSecure = target.protocol === "https:" || target.protocol === "wss:";
    if (pageSecure !== targetSecure) return endpoint;
    if ((page.port || audioDefaultPort(page.protocol)) !== (target.port || audioDefaultPort(target.protocol))) {
      return endpoint;
    }
    if (target.protocol === "http:" || target.protocol === "https:") target.protocol = page.protocol;
    else if (target.protocol === "ws:" || target.protocol === "wss:") target.protocol = pageSecure ? "wss:" : "ws:";
    target.host = page.host;
    return target.href;
  } catch {
    return endpoint;
  }
}
