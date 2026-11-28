import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER,
  classifyAnthropicFastRefusal,
  isAnthropicFastRefusal,
} from "../../src/providers/anthropic-fast";
import { createStore, decide, isInScopePerMessageEffortModel } from "../../src/responses/effort-history";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../../src/providers/quota";
import { commitKiroAccountUsageState } from "../../src/providers/kiro-usage";
import { kiroEvidenceIdentity } from "../../src/providers/kiro-account-state-disk";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import {
  PRIMARY_WINDOW_HOT_PERCENT,
  hasHeadroomEvidence,
  rankAccountsByHeadroom,
  rankAccountsByResetFirst,
} from "../../src/oauth/account-quota-rank";
import { rankPolicyFallbackCandidates } from "../../src/server/responses/policy-fallback";
import { cheapestSufficientCandidate, classifyRoleModelCandidates } from "../../src/codex/role-auto-assign";
import { parseChildObservations, updateChildObservations } from "../../src/link/child-observations";
import {
  LINK_RELAY_AUTH_PATH,
  LINK_RELAY_AUTH_VERSION,
  LINK_RELAY_PROBE_HEADER,
  linkRelayChallenge,
} from "../../src/link/relay-auth";
import type { LinkStore } from "../../src/link/store";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { claimQuotaReset } from "../../src/quota/reset-seen-store";
import { createOptionalListenerSet } from "../../src/server/index/optional-listeners";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { EpxConfig } from "../../src/types";
import type { RouteDecisionTraceV1 } from "../../src/server/responses/route-decision";

describe("P1 NaN/Infinity comparator and finite filters", () => {
  const originalHome = process.env.EASYPROXY_HOME;
  let tempHome: string | undefined;

  afterEach(() => {
    clearAccountQuotaCache();
    if (originalHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = originalHome;
    if (tempHome) {
      removeTreeWithRetry(tempHome);
      tempHome = undefined;
    }
  });

  test("account-quota-rank drops non-finite percents instead of poisoning headroom to NaN", () => {
    const now = Date.now();
    setCachedProviderAccountQuotaForTests("xai", "a", {
      fiveHourPercent: Number.NaN,
      weeklyPercent: 80,
      updatedAt: now,
    });
    setCachedProviderAccountQuotaForTests("xai", "b", {
      fiveHourPercent: 20,
      weeklyPercent: Number.POSITIVE_INFINITY,
      updatedAt: now,
    });
    // Account a has finite 80% (20% headroom); account b has finite 20% (80% headroom).
    expect(rankAccountsByHeadroom("xai", ["a", "b"])).toEqual(["b", "a"]);
  });

  test("rankPolicyFallbackCandidates handles missing or NaN score totals without NaN sort corruption", () => {
    const trace = {
      candidates: [
        { provider: "p1", model: "m1", eligible: true, exclusions: [], score: undefined },
        { provider: "p2", model: "m2", eligible: true, exclusions: [], score: { total: Number.NaN } },
        { provider: "p3", model: "m3", eligible: true, exclusions: [], score: { total: 42 } },
        { provider: "p4", model: "m4", eligible: true, exclusions: [], score: undefined },
      ],
    } as unknown as RouteDecisionTraceV1;
    const ranked = rankPolicyFallbackCandidates(trace, new Set());
    expect(ranked.map(c => c.provider)).toEqual(["p3", "p1", "p2", "p4"]);
  });

  test("role-auto-assign filters non-finite measured scores and prices cleanly", () => {
    const classified = classifyRoleModelCandidates(
      [
        { model: "m-nan", unitPrice: Number.NaN, efforts: [] },
        { model: "m-inf", unitPrice: Number.POSITIVE_INFINITY, efforts: [] },
        { model: "m-low", unitPrice: 1, efforts: [] },
        { model: "m-high", unitPrice: 10, efforts: [] },
      ],
      {},
      new Map([["m-nan", Number.NaN], ["m-low", 10], ["m-high", 20]]),
    );
    expect(classified.find(c => c.model === "m-nan")?.tier).toBeNull();
    const pick = cheapestSufficientCandidate(classified, "fast");
    expect(pick?.model).toBe("m-low");
  });

  test("parseChildObservations rejects Date.parse quirks and capEntries tie-breaks deterministically", () => {
    const parsed = parseChildObservations(JSON.stringify({
      schema: "epx.link.child-observations/1",
      homeCatalog: null,
      children: {
        lnk_0000000000000001: {
          observedAt: "bad-1",
          source: "plan",
          installedVersion: "1.0.0",
          installKind: "npm",
          runtimeOwner: null,
          updateRoute: "none",
          updateReason: null,
          targetVersion: null,
          catalogPulledAt: null,
          lastOperation: null,
          suppressedTarget: null,
          catalogPulledEtag: null,
          catalogSyncedEtag: null,
          autoUpdateAttempts: null,
          updateInFlight: null,
          pendingUpdateRecovery: null,
        },
        lnk_0000000000000002: {
          observedAt: "2026-09-09T24:00:00Z",
          source: "plan",
          installedVersion: "1.0.0",
          installKind: "npm",
          runtimeOwner: null,
          updateRoute: "none",
          updateReason: null,
          targetVersion: null,
          catalogPulledAt: null,
          lastOperation: null,
          suppressedTarget: null,
          catalogPulledEtag: null,
          catalogSyncedEtag: null,
          autoUpdateAttempts: null,
          updateInFlight: null,
          pendingUpdateRecovery: null,
        },
      },
    }));
    expect(Object.keys(parsed.children)).toEqual([]);

    tempHome = mkdtempSync(join(tmpdir(), "epx-child-obs-"));
    process.env.EASYPROXY_HOME = tempHome;
    mkdirSync(join(tempHome, "link"), { recursive: true });
    const obsPath = join(tempHome, "link", "child-observations.json");
    const storePath = join(tempHome, "link", "links.json");
    writeFileSync(storePath, "{ damaged");
    const validEntry = {
      observedAt: "2026-09-09T10:00:00Z",
      source: "plan" as const,
      installedVersion: "1.0.0",
      installKind: "npm" as const,
      runtimeOwner: null,
      updateRoute: "none" as const,
      updateReason: null,
      targetVersion: null,
      catalogPulledAt: null,
      lastOperation: null,
      suppressedTarget: null,
      catalogPulledEtag: null,
      catalogSyncedEtag: null,
      autoUpdateAttempts: null,
      updateInFlight: null,
      pendingUpdateRecovery: null,
    };
    const capped = updateChildObservations(
      file => {
        file.children.lnk_000000000000000b = { ...validEntry };
        file.children.lnk_000000000000000a = { ...validEntry };
      },
      { path: obsPath, storePath, maxEntries: 1 },
    );
    expect(Object.keys(capped.children)).toEqual(["lnk_000000000000000a"]);
  });

  test("claimQuotaReset ignores non-finite timestamp inputs fail-safely", () => {
    tempHome = mkdtempSync(join(tmpdir(), "epx-reset-seen-"));
    process.env.EASYPROXY_HOME = tempHome;
    expect(claimQuotaReset("k-nan", Number.NaN, Number.POSITIVE_INFINITY)).toBe(true);
    expect(claimQuotaReset("k-nan", Date.now())).toBe(false);
  });
});

describe("P2 enhancements from oh-my-pi (MIT) and mixdog (Apache-2.0)", () => {
  afterEach(() => {
    clearAccountQuotaCache();
  });

  test("anthropic-fast classifies overage-disabled headers into transient vs disabled while keeping 529 out of fast fallback", () => {
    const transient = new Headers({ [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits" });
    expect(classifyAnthropicFastRefusal(429, transient, "{}")).toBe("transient");
    expect(isAnthropicFastRefusal(429, transient, "{}")).toBe(true);

    const disabledUntil = new Headers({ [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "org_level_disabled_until" });
    expect(classifyAnthropicFastRefusal(429, disabledUntil, "{}")).toBe("transient");

    const disabled = new Headers({ [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "overage_not_provisioned" });
    expect(classifyAnthropicFastRefusal(429, disabled, "{}")).toBe("disabled");
    expect(isAnthropicFastRefusal(429, disabled, "{}")).toBe(true);

    expect(classifyAnthropicFastRefusal(400, new Headers(), JSON.stringify({ error: { message: "'sonnet' does not support the `speed` parameter." } }))).toBe("unsupported");
    expect(classifyAnthropicFastRefusal(529, new Headers(), JSON.stringify({ error: { message: "Fast mode is overloaded" } }))).toBeNull();
    expect(isAnthropicFastRefusal(529, new Headers(), JSON.stringify({ error: { message: "Fast mode is overloaded" } }))).toBe(false);

    // Overage disabled reason alongside standard 5h/7d exhaustion headers must NOT hijack OAuth pool failover
    // unless the body or fast-pool remaining header explicitly points at the fast lane.
    const std5hWithOverage = new Headers({
      [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits",
      "anthropic-ratelimit-unified-5h-status": "rejected",
    });
    expect(classifyAnthropicFastRefusal(429, std5hWithOverage, JSON.stringify({ error: { message: "Rate limit exceeded" } }))).toBeNull();
    expect(isAnthropicFastRefusal(429, std5hWithOverage, "{}")).toBe(false);

    const stdClaimWithOverage = new Headers({
      [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "org_level_disabled",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
    });
    expect(classifyAnthropicFastRefusal(429, stdClaimWithOverage, "{}")).toBeNull();
    expect(
      classifyAnthropicFastRefusal(
        429,
        std5hWithOverage,
        JSON.stringify({ error: { message: "Usage credits are required for fast mode." } }),
      ),
    ).toBe("transient");
    expect(
      classifyAnthropicFastRefusal(
        429,
        new Headers({
          [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-fast-input-tokens-remaining": "0",
        }),
        "{}",
      ),
    ).toBe("transient");

    const oauthAppsClaimWithOverage = new Headers({
      [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_oauth_apps",
    });
    expect(classifyAnthropicFastRefusal(429, oauthAppsClaimWithOverage, "{}")).toBeNull();

    const unifiedRejectedWithOverage = new Headers({
      [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits",
      "anthropic-ratelimit-unified-status": "rejected",
    });
    expect(classifyAnthropicFastRefusal(429, unifiedRejectedWithOverage, "{}")).toBeNull();
    expect(isAnthropicFastRefusal(429, unifiedRejectedWithOverage, "{}")).toBe(false);

    const overageOnlyRejected = new Headers({
      [ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER]: "out_of_credits",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "overage",
    });
    expect(classifyAnthropicFastRefusal(429, overageOnlyRejected, "{}")).toBe("transient");
  });

  test("effort-history uses family minimum floors to admit future Claude 5.x/6.x models while failing closed on out-of-scope", () => {
    for (const model of [
      "opus-5",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-opus-5-6",
      "claude-opus-6-0",
      "claude-sonnet-5-5",
      "claude-sonnet-5-6",
      "claude-haiku-5-5",
      "claude-haiku-5-6",
      "claude-fable-5-1",
      "claude-fable-5-2",
      "claude-fable-5-3",
      "claude-mythos-5-1",
      "claude-mythos-5-2",
    ]) {
      expect(isInScopePerMessageEffortModel(model)).toBe(true);
    }
    for (const rejected of [
      "claude-opus-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-mythos-preview",
      "gpt-5",
      "claude-opus-5-5-" + "a".repeat(200),
    ]) {
      expect(isInScopePerMessageEffortModel(rejected)).toBe(false);
    }

    const store = createStore();
    const d = decide(
      store,
      {
        effort: "low",
        chatLineage: "chat-future",
        scope: {
          cohort: "c1",
          provider: "anthropic",
          destination: "api.anthropic.com",
          adapter: "anthropic",
          model: "claude-opus-5-6",
          credential: "acct-1",
          authMode: "apiKey",
        },
        parent: [],
        suffix: [{ kind: "user", text: "hi" }],
        cacheControl: true,
        newTranscriptReceipt: true,
      },
      { enabled: true, activated: true, compactionMarkerIdentified: true },
    );
    expect(d.action).toBe("send");
  });

  test("rankAccountsByResetFirst demotes hot primary windows (>= 85%) behind cooler accounts", () => {
    const now = Date.now();
    expect(PRIMARY_WINDOW_HOT_PERCENT).toBe(85);
    setCachedProviderAccountQuotaForTests("google-antigravity", "hot-soon", {
      updatedAt: now,
      customWindows: [
        { label: "Gem", percent: 90, resetAt: now + 3_600_000 },
        { label: "Gem (Weekly)", percent: 40, resetAt: now + 86_400_000 },
      ],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "cool-later", {
      updatedAt: now,
      customWindows: [
        { label: "Gem", percent: 25, resetAt: now + 2 * 3_600_000 },
        { label: "Gem (Weekly)", percent: 40, resetAt: now + 4 * 86_400_000 },
      ],
    });
    expect(rankAccountsByResetFirst("google-antigravity", ["hot-soon", "cool-later"], "gemini-3.8-flash", now)).toEqual([
      "cool-later",
      "hot-soon",
    ]);
  });

  test("isPrimaryWindowHot evaluates passive quota freshness against injected now rather than wall clock", () => {
    const wallNow = Date.now();
    const simulatedFutureNow = wallNow + 2 * 60 * 60_000;
    setCachedProviderAccountQuotaForTests("meta-muse", "hot-stale-at-future-now", {
      updatedAt: wallNow,
      fiveHourPercent: 95,
      fiveHourResetAt: simulatedFutureNow + 3_600_000,
      weeklyPercent: 20,
      weeklyResetAt: simulatedFutureNow + 24 * 3_600_000,
    });
    setCachedProviderAccountQuotaForTests("meta-muse", "cool-later", {
      updatedAt: wallNow,
      fiveHourPercent: 20,
      fiveHourResetAt: simulatedFutureNow + 2 * 3_600_000,
      weeklyPercent: 20,
      weeklyResetAt: simulatedFutureNow + 48 * 3_600_000,
    });
    expect(rankAccountsByResetFirst("meta-muse", ["hot-stale-at-future-now", "cool-later"], null, simulatedFutureNow)).toEqual([
      "hot-stale-at-future-now",
      "cool-later",
    ]);
  });

  test("rankAccountsByResetFirst keeps hot measured healthy accounts ahead of unmeasured RANK_UNKNOWN candidates", () => {
    const now = Date.now();
    setCachedProviderAccountQuotaForTests("google-antigravity", "hot-measured", {
      updatedAt: now,
      customWindows: [
        { label: "Gem", percent: 90, resetAt: now + 3_600_000 },
        { label: "Gem (Weekly)", percent: 40, resetAt: now + 86_400_000 },
      ],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "cool-measured", {
      updatedAt: now,
      customWindows: [
        { label: "Gem", percent: 25, resetAt: now + 2 * 3_600_000 },
        { label: "Gem (Weekly)", percent: 40, resetAt: now + 4 * 86_400_000 },
      ],
    });
    expect(
      rankAccountsByResetFirst(
        "google-antigravity",
        ["unmeasured", "hot-measured", "cool-measured"],
        "gemini-3.8-flash",
        now,
      ),
    ).toEqual(["cool-measured", "hot-measured", "unmeasured"]);
  });

  test("rankAccountsByResetFirst demotes Kiro 100%-used unverified account behind unmeasured sibling and forwards injected now", async () => {
    const previousHome = process.env.EASYPROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "epx-kiro-reset-"));
    process.env.EASYPROXY_HOME = home;
    try {
      await saveCredential("kiro", {
        access: "access-a",
        refresh: "refresh-a",
        expires: Date.now() + 3_600_000,
        accountId: "kiro-a",
      }, { addAccount: true });
      await saveCredential("kiro", {
        access: "access-b",
        refresh: "refresh-b",
        expires: Date.now() + 3_600_000,
        accountId: "kiro-b",
      }, { addAccount: true });
      const roster = getAccountSet("kiro")!.accounts;
      const byName = (name: string) => roster.find(r => r.credential.accountId === name)!;
      const a = byName("kiro-a");
      const b = byName("kiro-b");
      const accountMap = new Map(roster.map(row => [row.id, row]));

      const writeAt = Date.now();
      setCachedProviderAccountQuotaForTests("kiro", a.id, {
        monthlyPercent: 100,
        monthlyResetAt: writeAt + 60_000,
        updatedAt: writeAt,
      });
      const evalNow = Date.now();
      expect(rankAccountsByHeadroom("kiro", [a.id, b.id], undefined, accountMap, evalNow)).toEqual([b.id, a.id]);
      expect(rankAccountsByResetFirst("kiro", [a.id, b.id], undefined, evalNow, accountMap)).toEqual([b.id, a.id]);

      commitKiroAccountUsageState(
        `kiro\0${a.id}`,
        {
          exhausted: true,
          nextResetAt: writeAt + 60_000,
        },
        kiroEvidenceIdentity(a),
      );
      const afterVerdictNow = Date.now();
      expect(rankAccountsByResetFirst("kiro", [a.id, b.id], undefined, afterVerdictNow, accountMap)).toEqual([b.id, a.id]);
      const expiredNow = writeAt + 120_000;
      expect(hasHeadroomEvidence("kiro", [a.id, b.id], undefined, accountMap, expiredNow)).toBe(false);
      expect(rankAccountsByResetFirst("kiro", [a.id, b.id], undefined, expiredNow, accountMap)).toEqual([a.id, b.id]);
    } finally {
      if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
});

describe("optional-listeners keyFingerprints fail-closed timestamp guard", () => {
  const originalHome = process.env.EASYPROXY_HOME;
  const servers: Array<Server<unknown>> = [];
  let tempHome: string | undefined;

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map(server => server.stop(true)));
    if (originalHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = originalHome;
    if (tempHome) {
      removeTreeWithRetry(tempHome);
      tempHome = undefined;
    }
  });

  test("rejects pendingRotation.expiresAt on bad-1, calendar overflow, 24:00:00, and >128B while keeping active key valid", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "epx-opt-listeners-ts-"));
    process.env.EASYPROXY_HOME = tempHome;
    const linkId = "lnk_0123456789abcdef";
    const keyId = "link-key";
    const primaryKey = "epx_data_primary_1111";
    const pendingKey = "epx_data_pending_2222";
    const storeState: { value: LinkStore } = {
      value: {
        version: 1,
        listenerPort: null,
        links: [{
          id: linkId,
          alias: "ts-guard",
          direction: "client-initiated",
          hostKeyFingerprint: "SHA256:abcdefghijklmnop",
          tunnelPort: 2222,
          apiKeyId: keyId,
          createdAt: "2026-09-25T00:00:00.000Z",
        }],
      },
    };
    const listeners = createOptionalListenerSet(
      {
        storePath: join(tempHome, "links.json"),
        readStore: () => storeState.value,
        writeStore: (_path, next) => { storeState.value = next; },
        warn: () => {},
        serve: options => {
          const bound = Bun.serve(options);
          servers.push(bound);
          return bound;
        },
      },
      {
        load: async () => ({
          startChildOpsHost: () => () => {},
          catalogRevision: () => ({}) as never,
        }),
      },
    );
    listeners.linkSupervisor().start = () => {};

    const cfg: EpxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      runtimeRole: "client",
      defaultProvider: "mock",
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["m1"] },
      },
      apiKeys: [{
        id: keyId,
        name: keyId,
        key: primaryKey,
        createdAt: "2026-09-25T00:00:00.000Z",
        pendingRotation: {
          id: "rot-1",
          key: pendingKey,
          createdAt: "2026-09-25T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }],
    };

    try {
      listeners.start({
        config: cfg,
        publicPort: 0,
        requestedPort: 0,
        maxRequestBodySize: 1024 * 1024,
        dispatch: async () => new Response("ok"),
      });
      const status = listeners.status();
      expect(status.state).toBe("listening");
      const base = `http://127.0.0.1:${status.port!}`;

      const probeRelayAuth = async (token: string): Promise<number> => {
        const { nonce, caller } = linkRelayChallenge(serviceApiTokenFingerprint(token), keyId, linkId);
        const query = new URLSearchParams({
          version: LINK_RELAY_AUTH_VERSION,
          key: keyId,
          link: linkId,
          nonce,
          proof: caller,
        });
        const response = await fetch(`${base}${LINK_RELAY_AUTH_PATH}?${query.toString()}`, {
          headers: { [LINK_RELAY_PROBE_HEADER]: "1" },
        });
        return response.status;
      };

      expect(await probeRelayAuth(pendingKey)).toBe(204);

      for (const badExpiry of [
        "bad-1",
        "bad-9999",
        "2099-02-30T00:00:00Z",
        "2099-09-09T24:00:00Z",
        `2099-01-01T00:00:00.${"0".repeat(150)}Z`,
        "2020-01-01T00:00:00Z",
        undefined as unknown as string,
        12345 as unknown as string,
      ]) {
        cfg.apiKeys![0]!.pendingRotation!.expiresAt = badExpiry;
        expect({ badExpiry, status: await probeRelayAuth(pendingKey) }).toEqual({ badExpiry, status: 404 });
        expect({ badExpiry, primaryStatus: await probeRelayAuth(primaryKey) }).toEqual({ badExpiry, primaryStatus: 204 });
      }

      // Malformed non-string/empty pendingRotation.key must fail closed without crashing primary key admission.
      cfg.apiKeys![0]!.pendingRotation = {
        id: "rot-empty",
        key: "",
        createdAt: "2026-09-25T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      expect(await probeRelayAuth(primaryKey)).toBe(204);
      cfg.apiKeys![0]!.pendingRotation = {
        id: "rot-missing-key",
        key: undefined as unknown as string,
        createdAt: "2026-09-25T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      expect(await probeRelayAuth(primaryKey)).toBe(204);

      // Corrupted primary key expiresAt fails closed across both primary and pending fingerprints.
      cfg.apiKeys![0]!.pendingRotation = {
        id: "rot-1",
        key: pendingKey,
        createdAt: "2026-09-25T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      cfg.apiKeys![0]!.expiresAt = "2099-02-30T00:00:00Z";
      expect(await probeRelayAuth(primaryKey)).toBe(404);
      expect(await probeRelayAuth(pendingKey)).toBe(404);
    } finally {
      await listeners.stop();
    }
  });
});
