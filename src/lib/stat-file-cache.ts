import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";

const nativeReadFileSync = nodeFs.readFileSync;
const nativeStatSync = nodeFs.statSync;

const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

interface StatStamp {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CacheEntry<T> {
  stamp: StatStamp;
  value: T;
}

function sameStat(stat: BigIntStats, stamp: StatStamp): boolean {
  return stat.dev === stamp.dev
    && stat.ino === stamp.ino
    && stat.size === stamp.size
    && stat.mtimeNs === stamp.mtimeNs
    && stat.ctimeNs === stamp.ctimeNs;
}

function stampFromStat(stat: BigIntStats): StatStamp {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function statFileIfPresent(path: string): BigIntStats | undefined {
  try {
    const stat = nodeFs.statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat && stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bounded stat-keyed synchronous file cache for hot read paths.
 * Bypasses caching whenever `node:fs` `readFileSync` or `statSync` is spied/mocked,
 * and validates stat identity before and after reads so torn writes are never cached.
 */
export class StatFileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxBytesBigInt: bigint;

  constructor(
    private readonly parse: (bytes: Buffer, path: string) => T,
    maxEntries = DEFAULT_MAX_CACHE_ENTRIES,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ) {
    this.maxEntries = Math.max(1, maxEntries);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
    this.maxBytesBigInt = BigInt(maxBytes);
  }

  read(path: string): T | undefined {
    if (nodeFs.readFileSync !== nativeReadFileSync || nodeFs.statSync !== nativeStatSync) {
      let raw: Buffer;
      try {
        raw = nodeFs.readFileSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          this.entries.delete(path);
          return undefined;
        }
        throw err;
      }
      if (raw.byteLength > this.maxBytes) {
        this.entries.delete(path);
        throw new RangeError(`File exceeds ${this.maxBytes} byte cache limit`);
      }
      return this.parse(raw, path);
    }

    const statBefore = statFileIfPresent(path);
    if (!statBefore) {
      this.entries.delete(path);
      return undefined;
    }
    if (statBefore.size > this.maxBytesBigInt) {
      this.entries.delete(path);
      throw new RangeError(`File exceeds ${this.maxBytes} byte cache limit`);
    }

    const cached = this.entries.get(path);
    if (cached && sameStat(statBefore, cached.stamp)) {
      return cached.value;
    }

    let raw: Buffer;
    try {
      raw = nodeFs.readFileSync(path);
    } catch (err) {
      this.entries.delete(path);
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
      throw err;
    }
    if (raw.byteLength > this.maxBytes) {
      this.entries.delete(path);
      throw new RangeError(`File exceeds ${this.maxBytes} byte cache limit`);
    }

    let value: T;
    try {
      value = this.parse(raw, path);
    } catch (err) {
      this.entries.delete(path);
      throw err;
    }

    const statAfter = statFileIfPresent(path);
    if (statAfter && sameStat(statBefore, statAfter)) {
      if (!this.entries.has(path) && this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      this.entries.set(path, { stamp: stampFromStat(statAfter), value });
    } else {
      this.entries.delete(path);
    }
    return value;
  }

  invalidate(path?: string): void {
    if (path === undefined) this.entries.clear();
    else this.entries.delete(path);
  }
}
