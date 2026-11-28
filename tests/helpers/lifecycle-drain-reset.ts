/**
 * Starts every case with an open server lifecycle.
 *
 * `drainAndShutdown` sets a process-lifetime latch in src/server/lifecycle.ts, and
 * `beginShutdownDrain` / `acquireTemporaryDrain` set state that only
 * `resetLifecycleDrainStateForTests` clears. Many files drain a proxy at the end of each case and
 * never reset: their later cases only call the management API, so nothing notices. A case that
 * needs admission (`tryAdmitTurn`, a Messages or Responses request) then gets null or a 503 for a
 * reason that lives in a different file. In one `bun test <dirs>` process, tests/clients/
 * omo-responses-loop.test.ts left the latch set and about 78 tests in tests/claude-integration/
 * failed that way.
 *
 * The preload calls this before each case, so a case never inherits a drain it did not start. It
 * resets only while a drain is set, which keeps other test-only lifecycle overrides intact. A case
 * that wants a drain starts it itself, after this hook has run.
 */
import { isDraining, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";

/** True when an inherited drain was cleared. */
export function clearInheritedLifecycleDrain(): boolean {
  if (!isDraining()) return false;
  resetLifecycleDrainStateForTests();
  return true;
}
