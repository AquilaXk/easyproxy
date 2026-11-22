import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  clearInteractionsForTests,
  forgetInteraction,
  INTERACTION_TTL_MS,
  interactionsRetainedStoreSnapshot,
  MAX_OWNER_INTERACTIONS,
  MAX_STORED_INTERACTIONS,
  recallInteraction,
  rememberInteraction,
} from "../../src/server/gemini-interactions-store";
import {
  authorizeGuiSessionRequest,
  deleteGuiSessionToken,
  GUI_SESSION_LIMIT,
  LOOPBACK_GUI_SESSION_TTL_MS,
  mintSession,
  revokeGuiSessionByCredential,
  type GuiSessionState,
} from "../../src/server/gui-session";
import { createManagementSessionControl, initializeManagementAuthState } from "../../src/server/management-auth";
import { forgetGuiDevice, rememberGuiDevice, resumeGuiDevice } from "../../src/server/persistent-gui-session";
import {
  clearOAuthRefreshIntentIfMatch,
  getAuthRefreshIntentPath,
  readOAuthRefreshIntent,
  writeOAuthRefreshIntent,
} from "../../src/oauth/store";
import { remoteConfig } from "../helpers/management-auth-fixture";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const ORIGIN = "https://dashboard.example.test";
const config = remoteConfig();

const entry = (id: string, owner: string, text = "ok") => ({
  id,
  owner,
  history: [{ role: "user", content: text }],
  resource: { id, steps: [] },
});

function authReq(token: string, method = "GET"): Request {
  return new Request(`${ORIGIN}/api/config`, {
    method,
    headers: {
      Host: "dashboard.example.test",
      Origin: ORIGIN,
      "X-EasyProxy-API-Key": token,
      "X-EasyProxy-GUI-Origin": ORIGIN,
    },
  });
}

function emptySessionState(): GuiSessionState {
  return { sessions: new Map(), pairingGrants: new Map() };
}

let activeHome: TempHome | null = null;
let previousToken: string | undefined;

afterEach(() => {
  clearInteractionsForTests();
  if (previousToken === undefined) delete process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
  else process.env.EASYPROXY_ADMIN_AUTH_TOKEN = previousToken;
  previousToken = undefined;
  activeHome?.remove();
  activeHome = null;
});

describe("gemini-interactions-store per-owner indexed oldestOf parity", () => {
  test("multi-owner interleaved writes evict only writer's oldest entries in FIFO order", () => {
    for (let i = 0; i < MAX_OWNER_INTERACTIONS; i++) {
      expect(rememberInteraction(entry(`a-${i}`, "owner-a"), 1_000 + i)).toBe(true);
      if (i % 4 === 0) expect(rememberInteraction(entry(`b-${i}`, "owner-b"), 1_000 + i)).toBe(true);
    }

    for (let i = 0; i < 5; i++) {
      expect(rememberInteraction(entry(`a-extra-${i}`, "owner-a"), 5_000 + i)).toBe(true);
      expect(recallInteraction(`a-${i}`, "owner-a", 6_000)).toBeUndefined();
      expect(recallInteraction(`a-${i + 1}`, "owner-a", 6_000)).toBeDefined();
    }
    expect(recallInteraction("b-0", "owner-b", 6_000)).toBeDefined();
  });

  test("overwriting an id moves it to the owner's tail and forgetInteraction advances the head", () => {
    for (let i = 0; i < MAX_OWNER_INTERACTIONS; i++) {
      expect(rememberInteraction(entry(`a-${i}`, "owner-a", `v1-${i}`), 100 + i)).toBe(true);
    }
    // Rewriting a-0 makes a-1 the oldest entry for owner-a.
    expect(rememberInteraction(entry("a-0", "owner-a", "v2-0"), 2_000)).toBe(true);
    expect(rememberInteraction(entry("a-tail-1", "owner-a"), 2_001)).toBe(true);
    expect(recallInteraction("a-0", "owner-a", 2_002)?.history).toEqual([{ role: "user", content: "v2-0" }]);
    expect(recallInteraction("a-1", "owner-a", 2_002)).toBeUndefined();

    // Forgetting the current head (a-2) makes a-3 the next entry evicted.
    expect(forgetInteraction("a-2", "owner-a", 2_002)).toBe(true);
    expect(rememberInteraction(entry("a-tail-2", "owner-a"), 2_003)).toBe(true);
    expect(recallInteraction("a-3", "owner-a", 2_004)).toBeDefined();
    expect(rememberInteraction(entry("a-tail-3", "owner-a"), 2_005)).toBe(true);
    expect(recallInteraction("a-3", "owner-a", 2_006)).toBeUndefined();
    expect(recallInteraction("a-4", "owner-a", 2_006)).toBeDefined();
  });

  test("TTL sweep and global cap eviction preserve per-owner index consistency", () => {
    for (let i = 0; i < 10; i++) {
      expect(rememberInteraction(entry(`old-${i}`, "owner-ttl"), 100 + i)).toBe(true);
    }
    const afterTtl = 100 + INTERACTION_TTL_MS + 10;
    expect(rememberInteraction(entry("fresh-0", "owner-ttl"), afterTtl)).toBe(true);
    expect(interactionsRetainedStoreSnapshot().count).toBe(1);
    expect(recallInteraction("old-0", "owner-ttl", afterTtl + 1)).toBeUndefined();
    expect(recallInteraction("fresh-0", "owner-ttl", afterTtl + 1)).toBeDefined();

    clearInteractionsForTests();
    for (let owner = 0; owner < MAX_STORED_INTERACTIONS / MAX_OWNER_INTERACTIONS; owner++) {
      for (let i = 0; i < MAX_OWNER_INTERACTIONS; i++) {
        expect(rememberInteraction(entry(`o${owner}-${i}`, `owner-${owner}`), 1_000 + i)).toBe(true);
      }
    }
    expect(rememberInteraction(entry("o2-new", "owner-2"), 10_000)).toBe(true);
    expect(recallInteraction("o2-0", "owner-2", 10_001)).toBeUndefined();
    expect(recallInteraction("o0-0", "owner-0", 10_001)).toBeDefined();
  });
});

describe("gui-session / management-auth / persistent-gui-session O(1) index parity", () => {
  test("HMAC-indexed lookup and revokeCurrent operate without scanning or rebuilding state.sessions.keys()", () => {
    previousToken = process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
    activeHome = createTempHome("epx-hotpath-parity-");
    process.env.EASYPROXY_ADMIN_AUTH_TOKEN = "epx_admin_parity";
    const state = initializeManagementAuthState(config);
    expect(state.available).toBe(true);
    if (!state.available) return;

    const now = 100_000;
    const issued = Array.from({ length: 16 }, (_, i) =>
      mintSession(ORIGIN, ORIGIN, "loopback", state, now + i));
    const control = createManagementSessionControl(state);

    const keysSpy = spyOn(state.sessions, "keys");
    try {
      const target = issued[7]!.token;
      const survivor = issued[12]!.token;

      expect(authorizeGuiSessionRequest(authReq(target), config, state, now + 100).ok).toBe(true);
      expect(control.revokeCurrent(authReq(target))).toBe(true);
      expect(control.revokeCurrent(authReq(target))).toBe(false);
      expect(authorizeGuiSessionRequest(authReq(target), config, state, now + 101)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(authorizeGuiSessionRequest(authReq("epx_session_forged_token"), config, state, now + 101)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(authorizeGuiSessionRequest(authReq(survivor), config, state, now + 101).ok).toBe(true);
      expect(revokeGuiSessionByCredential(state, survivor)).toBe(true);
      expect(authorizeGuiSessionRequest(authReq(survivor), config, state, now + 102)).toEqual({
        ok: false,
        reason: "missing",
      });
      // None of the O(1) lookups or revocations scanned or rebuilt the digest index.
      expect(keysSpy.mock.calls.length).toBe(0);
    } finally {
      keysSpy.mockRestore();
    }
  });

  test("forgetGuiDevice uses deleteGuiSessionToken and avoids index rebuilds", () => {
    previousToken = process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
    activeHome = createTempHome("epx-hotpath-forget-");
    process.env.EASYPROXY_ADMIN_AUTH_TOKEN = "epx_admin_forget_parity";
    const state = initializeManagementAuthState(config);
    expect(state.available).toBe(true);
    if (!state.available) return;

    const now = 200_000;
    const rememberReq = (ua: string) => new Request(`${ORIGIN}/api/session/remember`, {
      method: "POST",
      headers: {
        Host: "dashboard.example.test",
        Origin: ORIGIN,
        "User-Agent": ua,
      },
    });
    const deviceA = rememberGuiDevice(rememberReq("Device-A"), config, state, now)!;
    const deviceB = rememberGuiDevice(rememberReq("Device-B"), config, state, now + 1)!;
    const cookieA = deviceA.cookie.split(";")[0]!;
    const cookieB = deviceB.cookie.split(";")[0]!;
    const resumedA = resumeGuiDevice(new Request(`${ORIGIN}/`, {
      method: "GET",
      headers: {
        Host: "dashboard.example.test",
        Cookie: cookieA,
        "User-Agent": "Device-A",
        "X-EasyProxy-Device-Proof": deviceA.device.proof,
      },
    }), config, state, now + 2)!;
    expect(resumedA.token).toStartWith("epx_session_");

    const keysSpy = spyOn(state.sessions, "keys");
    try {
      const clearedCookie = forgetGuiDevice(new Request(`${ORIGIN}/api/session/logout`, {
        method: "POST",
        headers: {
          Host: "dashboard.example.test",
          Origin: ORIGIN,
          Cookie: cookieA,
          "User-Agent": "Device-A",
        },
      }), config, state);
      expect(clearedCookie).toContain("Max-Age=0");
      expect(state.sessions.has(deviceA.session.token)).toBe(false);
      expect(state.sessions.has(resumedA.token)).toBe(false);
      expect(state.sessions.has(deviceB.session.token)).toBe(true);
      expect(cookieB.length).toBeGreaterThan(0);

      expect(authorizeGuiSessionRequest(authReq(deviceA.session.token), config, state, now + 10)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(authorizeGuiSessionRequest(authReq(resumedA.token), config, state, now + 10)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(authorizeGuiSessionRequest(authReq("epx_session_unknown"), config, state, now + 10)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(authorizeGuiSessionRequest(authReq(deviceB.session.token), config, state, now + 10).ok).toBe(true);
      expect(keysSpy.mock.calls.length).toBe(0);
    } finally {
      keysSpy.mockRestore();
    }
  });

  test("TTL expiration and GUI_SESSION_LIMIT FIFO eviction maintain index parity", () => {
    const state = emptySessionState();
    const start = 1_000_000;
    const ttlSession = mintSession(ORIGIN, ORIGIN, "loopback", state, start);
    expect(authorizeGuiSessionRequest(authReq(ttlSession.token), config, state, start + LOOPBACK_GUI_SESSION_TTL_MS - 1).ok).toBe(true);
    expect(authorizeGuiSessionRequest(authReq(ttlSession.token), config, state, start + LOOPBACK_GUI_SESSION_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });

    const keysSpy = spyOn(state.sessions, "keys");
    try {
      expect(authorizeGuiSessionRequest(authReq("epx_session_absent"), config, state, start + LOOPBACK_GUI_SESSION_TTL_MS + 1)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(keysSpy.mock.calls.length).toBe(0);
    } finally {
      keysSpy.mockRestore();
    }

    const fifoState = emptySessionState();
    const minted = Array.from({ length: GUI_SESSION_LIMIT + 3 }, (_, i) =>
      mintSession(ORIGIN, ORIGIN, "loopback", fifoState, start + i));
    expect(fifoState.sessions.size).toBe(GUI_SESSION_LIMIT);
    const fifoSpy = spyOn(fifoState.sessions, "keys");
    try {
      for (let i = 0; i < 3; i++) {
        expect(authorizeGuiSessionRequest(authReq(minted[i]!.token), config, fifoState, start + 500)).toEqual({
          ok: false,
          reason: "missing",
        });
      }
      expect(authorizeGuiSessionRequest(authReq(minted[3]!.token), config, fifoState, start + 500).ok).toBe(true);
      expect(authorizeGuiSessionRequest(authReq(minted.at(-1)!.token), config, fifoState, start + 500).ok).toBe(true);
      expect(deleteGuiSessionToken(fifoState, minted[3]!.token)).toBe(true);
      expect(authorizeGuiSessionRequest(authReq("epx_session_after_delete"), config, fifoState, start + 501)).toEqual({
        ok: false,
        reason: "missing",
      });
      expect(fifoSpy.mock.calls.length).toBe(0);
    } finally {
      fifoSpy.mockRestore();
    }
  });
});

describe("oauth/store clearOAuthRefreshIntentIfMatch uncertain intent parity", () => {
  test("corrupt on-disk intent and uncertain caller expectation both refuse clearing", () => {
    activeHome = createTempHome("epx-hotpath-oauth-");
    const intent = writeOAuthRefreshIntent("anthropic", "acct-parity", "a".repeat(64), 10_000);
    expect(clearOAuthRefreshIntentIfMatch("anthropic", "acct-parity", { ...intent, uncertain: true })).toBe(false);
    expect(readOAuthRefreshIntent("anthropic", "acct-parity")).toEqual(intent);

    writeFileSync(getAuthRefreshIntentPath("anthropic", "acct-parity"), "{corrupt-json", "utf8");
    expect(clearOAuthRefreshIntentIfMatch("anthropic", "acct-parity", intent)).toBe(false);
    expect(clearOAuthRefreshIntentIfMatch("anthropic", "acct-parity", { ...intent, uncertain: true })).toBe(false);
  });
});
