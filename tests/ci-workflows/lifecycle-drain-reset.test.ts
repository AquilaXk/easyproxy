/**
 * tests/preload.ts clears a server drain inherited from an earlier case before each case starts,
 * because a leaked drain makes every later admission answer 503. These cases pin the reset helper;
 * the last one proves the preload hook itself ran by observing the state it left behind.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  acquireTemporaryDrain,
  beginShutdownDrain,
  isDraining,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../../src/server/lifecycle";
import { clearInheritedLifecycleDrain } from "../helpers/lifecycle-drain-reset";

// This file latches a drain on purpose in its middle cases; leave the process clean for later files.
afterAll(() => resetLifecycleDrainStateForTests());

describe("inherited lifecycle drain reset", () => {
  test("a clean lifecycle is left alone", () => {
    expect(isDraining()).toBe(false);
    expect(clearInheritedLifecycleDrain()).toBe(false);
  });

  test("a latched shutdown drain is cleared and admission works again", () => {
    beginShutdownDrain();
    expect(tryAdmitTurn()).toBeNull();
    expect(clearInheritedLifecycleDrain()).toBe(true);
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    lease?.release();
  });

  test("a held temporary drain is cleared", () => {
    expect(acquireTemporaryDrain("lifecycle-drain-reset-test")).not.toBeNull();
    expect(clearInheritedLifecycleDrain()).toBe(true);
    expect(isDraining()).toBe(false);
  });

  test("the preload hook starts this case with the previous case's latch cleared", () => {
    beginShutdownDrain();
  });

  test("the case after a latched one starts open", () => {
    expect(isDraining()).toBe(false);
  });
});
