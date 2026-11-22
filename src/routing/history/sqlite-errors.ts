/** Only structural SQLite damage justifies discarding the derived index. */
export function isHistoryIndexCorruption(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  // Bun exposes extended result codes too; the low byte is the primary code.
  if (typeof errno === "number" && ((errno & 0xff) === 11 || (errno & 0xff) === 26)) return true;
  return typeof code === "string"
    && /^(SQLITE_CORRUPT(?:_[A-Z]+)?|SQLITE_NOTADB)$/.test(code);
}

/** True when SQLite rejected an operation immediately under write-lock contention (`SQLITE_BUSY` / `SQLITE_LOCKED`). */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  if (typeof errno === "number" && ((errno & 0xff) === 5 || (errno & 0xff) === 6)) return true;
  return typeof code === "string"
    && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)?$/.test(code);
}
