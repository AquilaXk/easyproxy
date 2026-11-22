import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AtomicWriteHooks } from "../config/atomic-write";
import { assertCodexHomeOwner, CODEX_HOME_JOURNAL_FILE } from "./codex-home-owner";
import { CODEX_HOME } from "./paths";

/**
 * Canonical path to the native Codex injection journal inside `CODEX_HOME`.
 */
export const JOURNAL_PATH = join(CODEX_HOME, CODEX_HOME_JOURNAL_FILE);

export function removeJournal(hooks: AtomicWriteHooks = {}): void {
  assertCodexHomeOwner(CODEX_HOME);
  hooks.validateBeforeRename?.(JOURNAL_PATH);
  try { unlinkSync(JOURNAL_PATH); } catch { return; }
  hooks.afterRename?.(JOURNAL_PATH);
}
