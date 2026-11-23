import http2 from "node:http2";
import type { PinnedAddress } from "../../lib/pinned-http";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;

interface PoolEntry {
  readonly session: http2.ClientHttp2Session;
  readonly streams: Set<http2.ClientHttp2Stream>;
  usable: boolean;
}

/**
 * HTTP/2 connection pool for Cursor Connect DISCOVERY calls (GetUsableModels).
 * Sessions are keyed by origin (scheme+host+port) and reused to avoid fresh
 * TCP+TLS per call. The Run path deliberately dials its own session: Run
 * streams are long-lived bidi whose lifecycle/EOF semantics are owned by
 * live-transport (see devlog 260822_senpi_cursor_transfer/190 — Run-path
 * pooling is a separate, deliberate unit if ever taken).
 */
export class CursorH2SessionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly retired = new Set<PoolEntry>();
  private closed = false;

  constructor(
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
    private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  /**
   * Lazily registered on first use so a process that never talks to Cursor registers
   * nothing (optional-subsystem doctrine). The seam is synchronous and best-effort;
   * shutdown() is fire-and-forget there because lifecycle's drainAndShutdown runs
   * under its own absolute deadline.
   */
  private armShutdownHook: (() => void) | undefined = () => {
    this.armShutdownHook = undefined;
    registerOptionalShutdownHook("cursor-h2-pool", () => { void this.shutdown(); });
  };

  request(
    url: string,
    headers: http2.OutgoingHttpHeaders,
    credentialScope?: string,
    pinnedAddress?: PinnedAddress,
  ): http2.ClientHttp2Stream {
    if (this.closed) throw new Error("Cursor H2 session pool is closed");
    this.armShutdownHook?.();
    const origin = new URL(url).origin;
    const pinScope = pinnedAddress ? `${pinnedAddress.address}/${pinnedAddress.family}` : "";
    const poolKey = credentialScope || pinScope ? `${origin}\0${credentialScope ?? ""}\0${pinScope}` : origin;
    const entry = this.usableEntry(poolKey) ?? this.createEntry(origin, poolKey, pinnedAddress);
    try {
      const stream = entry.session.request(headers);
      entry.streams.add(stream);
      stream.once("close", () => { entry.streams.delete(stream); });
      return stream;
    } catch (error) {
      this.drain(entry, true);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const allEntries = new Set<PoolEntry>([...this.entries.values(), ...this.retired]);
    this.entries.clear();
    this.retired.clear();
    const pending: Promise<void>[] = [];
    for (const entry of allEntries) {
      for (const stream of [...entry.streams]) stream.destroy();
      entry.streams.clear();
      if (!entry.session.closed && !entry.session.destroyed) {
        entry.session.close();
      }
      if (entry.session.destroyed) continue;
      pending.push(new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          try { entry.session.destroy(); } catch { /* ignore */ }
          resolve();
        }, SESSION_CLOSE_TIMEOUT_MS);
        timer.unref?.();
        entry.session.once("close", () => { clearTimeout(timer); resolve(); });
      }));
    }
    await Promise.all(pending);
  }

  get size(): number { return this.entries.size; }

  private usableEntry(poolKey: string): PoolEntry | undefined {
    const entry = this.entries.get(poolKey);
    if (!entry) return undefined;
    if (entry.usable && !entry.session.closed && !entry.session.destroyed) return entry;
    this.drain(entry, false);
    return undefined;
  }

  private createEntry(origin: string, poolKey = origin, pinnedAddress?: PinnedAddress): PoolEntry {
    const connectOptions: http2.SecureClientSessionOptions | undefined = pinnedAddress
      ? {
        lookup(_hostname, lookupOptions, callback) {
          const opts = typeof lookupOptions === "function" ? undefined : lookupOptions;
          const cb = typeof lookupOptions === "function" ? lookupOptions : callback;
          if (!cb) return;
          if (opts && typeof opts === "object" && "all" in opts && opts.all) {
            (cb as (error: NodeJS.ErrnoException | null, addresses: PinnedAddress[]) => void)(
              null,
              [{ address: pinnedAddress.address, family: pinnedAddress.family }],
            );
            return;
          }
          (cb as (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(
            null,
            pinnedAddress.address,
            pinnedAddress.family as 4 | 6,
          );
        },
      }
      : undefined;
    const session = connectOptions ? http2.connect(origin, connectOptions) : http2.connect(origin);
    const entry: PoolEntry = {
      session,
      streams: new Set(),
      usable: true,
    };
    this.entries.set(poolKey, entry);
    session.setTimeout(this.idleTimeoutMs, () => {
      if (entry.streams.size === 0) this.drain(entry, true);
    });
    session.once("goaway", (errorCode: number) => {
      if (errorCode === 0 && entry.streams.size > 0) this.retire(entry, true);
      else this.drain(entry, true);
    });
    session.on("error", () => { this.drain(entry, false); });
    session.once("close", () => {
      // Identity check: a stale close event from an old session must not evict
      // a healthy replacement entry that was created after drain() removed the old one.
      if (this.entries.get(poolKey) === entry) this.entries.delete(poolKey);
      this.retired.delete(entry);
    });
    // Enforce bound: retire oldest when over capacity without aborting active streams.
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (!oldest || oldest === poolKey) break;
      const old = this.entries.get(oldest);
      if (!old) {
        this.entries.delete(oldest);
        continue;
      }
      if (old.streams.size > 0) {
        this.retire(old, true);
      } else {
        this.drain(old, true);
      }
    }
    return entry;
  }

  private retire(entry: PoolEntry, closeSession: boolean): void {
    entry.usable = false;
    for (const [key, value] of this.entries) {
      if (value === entry) { this.entries.delete(key); break; }
    }
    if (!this.closed && !entry.session.destroyed) {
      this.retired.add(entry);
      if (closeSession && !entry.session.closed) {
        entry.session.close();
      }
    }
  }

  private drain(entry: PoolEntry, closeSession: boolean): void {
    for (const stream of [...entry.streams]) stream.destroy();
    entry.streams.clear();
    this.retire(entry, closeSession);
    if (entry.session.destroyed) this.retired.delete(entry);
  }
}

/** Shared singleton pool for all Cursor adapter H2 traffic. */
export const cursorH2Pool = new CursorH2SessionPool();
