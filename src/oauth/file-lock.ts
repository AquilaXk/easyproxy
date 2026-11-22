import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir, hardenConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { statTimeMs } from "../lib/file-identity";

export function getAuthRefreshIntentLockPath(provider: string, accountId: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
  const accountHash = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(getConfigDir(), `auth.refresh.${safeProvider}.${accountHash}.lock`);
}

export class OAuthFileLockError extends Error {
  readonly code = "OAUTH_FILE_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthFileLockError";
  }
}

export interface LockSnapshot {
  bytes: string;
  dev: bigint;
  ino: bigint;
  mtimeMs: number;
  mtimeNs: bigint;
  size: bigint;
}

export interface OAuthFileLockOptions {
  path: string;
  waitTimeoutMs?: number;
  staleAfterMs?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  beforeStaleUnlink?: () => void;
  beforeReleaseUnlink?: () => void;
  beforeFailedCreateUnlink?: () => void;
  writeMetadata?: (fd: number, bytes: string) => void;
}

export interface OAuthFileLockGuard {
  readonly ownerId: string;
  release(): void;
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function snapshot(path: string): LockSnapshot {
  const bytes = readFileSync(path, "utf8");
  const stat = statSync(path, { bigint: true });
  return {
    bytes,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: statTimeMs(stat.mtimeNs),
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

export function sameSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.bytes === b.bytes
    && a.dev === b.dev
    && a.ino === b.ino
    && a.mtimeNs === b.mtimeNs
    && a.size === b.size;
}

function sameFd(a: LockSnapshot, b: BigIntStats): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mtimeNs === b.mtimeNs
    && a.size === b.size;
}

export function createOAuthFileLock(
  options: OAuthFileLockOptions,
): { acquire(): Promise<OAuthFileLockGuard> } {
  const wait = options.waitTimeoutMs ?? 5000;
  const stale = options.staleAfterMs ?? 120000;
  const min = options.pollMinMs ?? 25;
  const max = options.pollMaxMs ?? 100;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const write = options.writeMetadata ?? ((fd, bytes) => writeFileSync(fd, bytes, "utf8"));
  if (wait < 0 || stale <= 0 || min < 0 || max < min) {
    throw new OAuthFileLockError("Invalid OAuth file-lock timing options");
  }

  return {
    async acquire() {
      hardenConfigDir();
      recordOwnedConfigPath(getConfigDir(), options.path);
      if (!existsSync(getConfigDir())) {
        mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
      }
      const ownerId = randomUUID();
      const started = now();
      for (;;) {
        let fd: number | undefined;
        try {
          fd = openSync(options.path, "wx", 0o600);
          const bytes = `${JSON.stringify({ version: 1, ownerId, pid: process.pid, createdAt: now() })}\n`;
          write(fd, bytes);
          const fdStat = fstatSync(fd, { bigint: true });
          closeSync(fd);
          fd = undefined;
          const owned = snapshot(options.path);
          if (owned.bytes !== bytes || !sameFd(owned, fdStat)) {
            throw new OAuthFileLockError("OAuth lock changed during creation");
          }
          let released = false;
          return {
            ownerId,
            release() {
              if (released) return;
              released = true;
              try {
                const current = snapshot(options.path);
                if (!sameSnapshot(owned, current)) return;
                options.beforeReleaseUnlink?.();
                const confirmed = snapshot(options.path);
                if (sameSnapshot(owned, confirmed)) unlinkSync(options.path);
              } catch (err) {
                if (errorCode(err) !== "ENOENT") {
                  console.warn(`[oauth] lock release failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            },
          };
        } catch (err) {
          if (fd !== undefined) {
            let fdStat: BigIntStats | undefined;
            try {
              fdStat = fstatSync(fd, { bigint: true });
            } catch {
              /* best effort: no identity, no cleanup */
            }
            try {
              closeSync(fd);
            } catch {
              /* best effort */
            }
            if (fdStat) {
              try {
                const current = snapshot(options.path);
                if (sameFd(current, fdStat)) {
                  options.beforeFailedCreateUnlink?.();
                  const confirmed = snapshot(options.path);
                  if (sameSnapshot(current, confirmed) && sameFd(confirmed, fdStat)) {
                    unlinkSync(options.path);
                  }
                }
              } catch {
                /* best-effort cleanup of our own failed create */
              }
            }
          }
          if (errorCode(err) !== "EEXIST") {
            throw err instanceof OAuthFileLockError
              ? err
              : new OAuthFileLockError("Could not create OAuth file lock", { cause: err });
          }
        }

        try {
          const current = snapshot(options.path);
          let created = current.mtimeMs;
          try {
            const parsed = JSON.parse(current.bytes) as { createdAt?: unknown };
            if (typeof parsed.createdAt === "number") {
              created = Math.max(created, parsed.createdAt);
            }
          } catch {
            /* unparsable metadata: fall back to mtime */
          }
          if (now() - created > stale) {
            options.beforeStaleUnlink?.();
            const confirmed = snapshot(options.path);
            if (sameSnapshot(current, confirmed)) unlinkSync(options.path);
            continue;
          }
        } catch (err) {
          if (errorCode(err) === "ENOENT") continue;
          throw new OAuthFileLockError("Could not inspect OAuth file lock", { cause: err });
        }

        const elapsed = now() - started;
        if (elapsed >= wait) {
          throw new OAuthFileLockError(`Timed out after ${wait}ms waiting for OAuth file lock`);
        }
        await sleep(Math.min(wait - elapsed, min + Math.floor(random() * (max - min + 1))));
      }
    },
  };
}

/** Wait long enough for slow IdP refreshes (e.g. Cursor 15s × 3 attempts) before timing out. */
export const OAUTH_REFRESH_LOCK_WAIT_MS = 60_000;

export function createOAuthRefreshIntentLock(
  provider: string,
  accountId: string,
  overrides: Partial<OAuthFileLockOptions> = {},
) {
  return createOAuthFileLock({
    path: getAuthRefreshIntentLockPath(provider, accountId),
    staleAfterMs: 120000,
    waitTimeoutMs: OAUTH_REFRESH_LOCK_WAIT_MS,
    ...overrides,
  });
}
