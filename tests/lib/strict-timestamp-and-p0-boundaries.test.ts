import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintAuthorityWithExtensionsForTests } from "../../src/claude/intercept/local-ca";
import {
  ensureDesktopCompatibilityAuthority,
  inspectDesktopCompatibilityAuthority,
  loadDesktopCompatibilityAuthority,
} from "../../src/codex/desktop-compatibility/certificate-store";
import type { AuthorityKeyProtection } from "../../src/codex/desktop-compatibility/windows-key-protection";
import { parseStrictTimestampMs } from "../../src/lib/strict-timestamp";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import {
  commitApiKeyRotation,
  removeExpiredApiKeyRotations,
  startApiKeyRotation,
} from "../../src/server/management/api-key-rotation";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import { resolveNextEligibleTelemetryDay, type TelemetryState } from "../../src/telemetry/scheduler";
import { readTelemetryStateFile, telemetryStatePath } from "../../src/telemetry/state";
import { parseRetryAfterMs as parseTelemetryRetryAfterMs } from "../../src/telemetry/sender";
import { readTelemetryInstallId, telemetryIdPath } from "../../src/telemetry/install-id";
import { setProfileClientOverridesForTests } from "../../src/telemetry/profile/client";
import { readTelemetryProfileFile } from "../../src/telemetry/profile/state";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import { runProfileTick } from "../../src/telemetry/profile/sync";
import { anthropicRetryAfterMs } from "../../src/oauth/anthropic-rate-limit-policy";
import { isSameTargetRetryHold, retryAfterDelayMs } from "../../src/lib/upstream-retry";
import { parseRetryAfterMs as parseCodexRetryAfterMs } from "../../src/codex/routing/cooldown-math";
import { parseQuotaResetAt } from "../../src/providers/key-failover";
import { MistralBudgetPacer, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { applyApiKeyBudgetPatch } from "../../src/server/management/api-key-budget-dto";
import {
  isApiKeyExpired,
  isContextPrincipalCurrent,
  resolveContextPrincipal,
} from "../../src/server/auth-cors";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import type { EpxApiKeyEntry, EpxConfig } from "../../src/types";

describe("parseStrictTimestampMs deterministic UTC and rejection", () => {
  test("rejects Date.parse heuristics, calendar overflows, out-of-range clock parts, and leading whitespace", () => {
    const bad = [
      "",
      "   ",
      "bad-1",
      "not-a-date",
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-09-09T24:00:00Z",
      "2026-09-09T00:60:00Z",
      "2026-09-09T00:00:60Z",
      "2026-09-09T00:00:00+25:00",
      "2026-09-09T00:00:00+00:60",
      " 2026-09-09T00:00:00Z",
    ];
    for (const value of bad) {
      expect(Number.isNaN(parseStrictTimestampMs(value))).toBe(true);
    }
  });

  test("normalizes offset-less datetimes to UTC identically across host timezones", () => {
    const expected = Date.UTC(2026, 8, 9, 3, 30, 6, 0);
    expect(parseStrictTimestampMs("2026-09-09T03:30:06")).toBe(expected);
    expect(parseStrictTimestampMs("2026-09-09 03:30:06")).toBe(expected);
    expect(parseStrictTimestampMs("2026-09-09T03:30")).toBe(Date.UTC(2026, 8, 9, 3, 30, 0, 0));
    expect(parseStrictTimestampMs("2026-09-09T03:30:06.5Z")).toBe(Date.UTC(2026, 8, 9, 3, 30, 6, 500));
    expect(parseStrictTimestampMs("2026-09-09T12:30:06.123999+09:00")).toBe(Date.UTC(2026, 8, 9, 3, 30, 6, 123));

    const script = 'import { parseStrictTimestampMs } from "./src/lib/strict-timestamp.ts"; console.log(parseStrictTimestampMs("2026-09-09T03:30:06"));';
    const kst = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(),
      env: { ...process.env, TZ: "Asia/Seoul" },
      encoding: "utf8",
    });
    const pdt = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    });
    expect(kst.status).toBe(0);
    expect(pdt.status).toBe(0);
    expect(kst.stdout.trim()).toBe(String(expected));
    expect(pdt.stdout.trim()).toBe(String(expected));
  });

  test("strict HTTP-date checks weekday by default, while legacyHttpDate tolerates mismatched weekday", () => {
    expect(Number.isNaN(parseStrictTimestampMs("Wed, 21 Oct 2027 07:28:00 GMT"))).toBe(true);
    expect(parseStrictTimestampMs("Thu, 21 Oct 2027 07:28:00 GMT")).toBe(Date.UTC(2027, 9, 21, 7, 28, 0));
    expect(parseStrictTimestampMs("Wed, 21 Oct 2027 07:28:00 GMT", { now: 0, legacyHttpDate: true })).toBe(Date.UTC(2027, 9, 21, 7, 28, 0));
  });
});

describe("P0 fail-closed timestamp consumers", () => {
  test("api-key-rotation cleans up and expires malformed pendingRotation.expiresAt fail-closed", () => {
    const now = Date.UTC(2026, 8, 10, 0, 0, 0);
    for (const badExpiry of ["bad-1", "2026-02-30T00:00:00Z", "2026-09-09T24:00:00Z"]) {
      const rotId = randomUUID();
      const cfg = {
        apiKeys: [{
          id: "k1",
          name: "k1",
          key: "epx_data_1111",
          createdAt: "2026-09-01T00:00:00Z",
          pendingRotation: { id: rotId, key: "epx_data_2222", createdAt: "2026-09-01T00:00:00Z", expiresAt: badExpiry },
        }],
      } as unknown as EpxConfig;
      expect(commitApiKeyRotation(structuredClone(cfg), "k1", rotId, now)).toEqual({ error: "expired" });
      const cleaned = structuredClone(cfg);
      expect(removeExpiredApiKeyRotations(cleaned, now)).toBe(true);
      expect(cleaned.apiKeys?.[0]?.pendingRotation).toBeUndefined();
      const started = startApiKeyRotation(structuredClone(cfg), "k1", now);
      expect("rotationId" in started).toBe(true);
    }
  });

  test("telemetry consent and scheduler reject malformed timestamps fail-closed", () => {
    const status = resolveTelemetryStatus({
      telemetry: { decision: "accepted", decidedAt: "bad-1", noticeShownAt: "2026-02-30T00:00:00Z" },
    }, {});
    expect(status.decidedAt).toBeNull();
    expect(status.noticeShownAt).toBeNull();

    const state: TelemetryState = { schemaVersion: 1, sentDays: {} };
    expect(resolveNextEligibleTelemetryDay({
      ...status,
      decidedAt: "2026-09-09T24:00:00Z",
    }, state, Date.UTC(2026, 8, 12, 0, 0, 0))).toEqual({ day: null, reason: "invalid-consent-timestamp" });
  });

  test("retry-after and quota-reset parsers ignore bad strings, 0x hex, negatives, and 24:00:00 overflow", () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0);
    for (const header of ["bad-1", "0x10", "-5", "2026-02-30T00:00:00Z", "2026-09-09T24:00:00Z"]) {
      expect(retryAfterDelayMs(new Headers({ "retry-after": header }))).toBeUndefined();
      expect(parseCodexRetryAfterMs(header, now)).toBeUndefined();
    }
    const overflowBody = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Will reset at 2026-09-09T24:00:00Z" },
    });
    expect(parseQuotaResetAt(overflowBody, now)).toBeUndefined();
    const naiveBody = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Will reset at 2026-09-09T03:30:06" },
    });
    expect(parseQuotaResetAt(naiveBody, now)).toBe(Date.UTC(2026, 8, 9, 3, 30, 6));
  });

  test("api-key-budget-dto and isApiKeyExpired reject calendar overflow and 24:00:00 instants", () => {
    const entry = {
      id: "k1",
      name: "k1",
      key: "epx_data_1111",
      createdAt: "2026-09-01T00:00:00Z",
    } as EpxApiKeyEntry;
    expect(applyApiKeyBudgetPatch(entry, { expiresAt: "2026-02-30T00:00:00Z" }).ok).toBe(false);
    expect(applyApiKeyBudgetPatch(entry, { expiresAt: "2026-09-09T24:00:00Z" }).ok).toBe(false);
    expect(applyApiKeyBudgetPatch(entry, { expiresAt: "2027-02-28T12:00:00Z" }).ok).toBe(true);
    expect(isApiKeyExpired({ expiresAt: "2026-02-30T00:00:00Z" }, Date.UTC(2026, 0, 1))).toBe(true);
    expect(isApiKeyExpired({ expiresAt: "2026-09-09T24:00:00Z" }, Date.UTC(2026, 0, 1))).toBe(true);
  });

  test("parseStrictTimestampMs rejects >128 byte inputs, isContextPrincipalCurrent rejects overflow expiry, and Retry-After / telemetry parsers fail closed", () => {
    expect(Number.isNaN(parseStrictTimestampMs(`2026-01-01T00:00:00.${"0".repeat(200)}Z`))).toBe(true);

    const config: EpxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "test",
      providers: {
        test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["gpt-test"] },
      },
      apiKeys: [{
        id: "k1",
        name: "k1",
        key: "epx_data_1111",
        createdAt: "2026-09-01T00:00:00Z",
        pendingRotation: {
          id: "rot-1",
          key: "epx_data_pending",
          createdAt: "2026-09-01T00:00:00Z",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }],
    };
    const pendingPrincipal = resolveContextPrincipal(
      new Request("https://proxy.test/v1/responses", {
        method: "POST",
        headers: { "x-easyproxy-api-key": "epx_data_pending" },
      }),
      config,
      { kind: "loopback", source: "loopback" },
    );
    expect(isContextPrincipalCurrent(pendingPrincipal, config)).toBe(true);
    config.apiKeys![0]!.pendingRotation!.expiresAt = "2099-02-30T00:00:00Z";
    expect(isContextPrincipalCurrent(pendingPrincipal, config)).toBe(false);
    config.apiKeys![0]!.pendingRotation!.expiresAt = "2099-09-09T24:00:00Z";
    expect(isContextPrincipalCurrent(pendingPrincipal, config)).toBe(false);

    const now = Date.UTC(2026, 8, 1, 0, 0, 0);
    for (const invalidRetry of ["bad-1", "2099-02-30T00:00:00Z", "2099-09-09T24:00:00Z", `2026-09-01T00:00:00.${"0".repeat(150)}Z`]) {
      expect(anthropicRetryAfterMs(invalidRetry, now)).toBeUndefined();
      expect(parseTelemetryRetryAfterMs(invalidRetry, now)).toBeNull();
    }
    expect(anthropicRetryAfterMs("5", now)).toBe(5_000);
    expect(parseTelemetryRetryAfterMs("Tue, 01 Sep 2026 00:00:10 GMT", now)).toBe(10_000);
  });
});

describe("telemetry install-id and profile reject calendar-overflow timestamps", () => {
  let tempDir: string | undefined;
  afterEach(() => {
    if (tempDir) {
      removeTreeWithRetry(tempDir);
      tempDir = undefined;
    }
  });

  test("readTelemetryInstallId and readTelemetryProfileFile fail closed on overflow/heuristic dates", () => {
    tempDir = mkdtempSync(join(tmpdir(), "epx-strict-ts-"));
    writeFileSync(telemetryIdPath(tempDir), JSON.stringify({
      version: 1,
      installId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-02-30T00:00:00Z",
    }));
    expect(readTelemetryInstallId(tempDir)).toBeNull();

    writeFileSync(telemetryProfilePath(tempDir), JSON.stringify({
      version: 1,
      handle: "alice-dev",
      displayName: "Alice",
      avatar: "blue",
      secret: `epxp_${"a".repeat(43)}`,
      connectedAt: "2026-02-30T00:00:00Z",
      connectedDay: "2026-02-28",
      sentDays: {},
      lastSentDay: null,
      lastSentAt: null,
      retryAfterUntil: null,
      pendingDelete: false,
      revoked: false,
    }));
    expect(readTelemetryProfileFile(tempDir)).toEqual({ state: null, unreadable: true });

    writeFileSync(telemetryProfilePath(tempDir), JSON.stringify({
      version: 1,
      handle: "alice-dev",
      displayName: "Alice",
      avatar: "blue",
      secret: `epxp_${"a".repeat(43)}`,
      connectedAt: "2026-02-28T00:00:00Z",
      connectedDay: "2026-02-28",
      sentDays: {},
      lastSentDay: null,
      lastSentAt: "bad-1",
      retryAfterUntil: "2099-02-30T00:00:00Z",
      pendingDelete: false,
      revoked: false,
    }));
    const validProfile = readTelemetryProfileFile(tempDir);
    expect(validProfile.unreadable).toBe(false);
    expect(validProfile.state?.lastSentAt).toBeNull();
    expect(validProfile.state?.retryAfterUntil).toBeNull();
  });
});

describe("desktop-compatibility certificate-store validToDate and validatedAuthority bounds", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (tempDir) {
      removeTreeWithRetry(tempDir);
      tempDir = undefined;
    }
  });

  function makeProtector(): AuthorityKeyProtection {
    const key = randomBytes(32);
    return {
      async protect(cleartext) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(cleartext), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      async unprotect(ciphertext) {
        const data = Buffer.from(ciphertext);
        const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        cipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
      },
    };
  }

  test("inspectDesktopCompatibilityAuthority and validatedAuthority reject non-finite now, pre-validity, oversized validity, and corrupt X.509 dates", async () => {
    const okAcl = () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" });
    setIcaclsRunnerForTests(okAcl);
    setAsyncIcaclsRunnerForTests(async () => okAcl());

    tempDir = mkdtempSync(join(tmpdir(), "epx-cert-store-ts-"));
    const protection = makeProtector();
    const prepared = await ensureDesktopCompatibilityAuthority({ directory: tempDir, protection });
    const cert = new X509Certificate(prepared.authority.certPem);
    const expectedFrom = cert.validFromDate.getTime();
    const expectedTo = cert.validToDate.getTime();

    expect(inspectDesktopCompatibilityAuthority(tempDir, Number.NaN)).toEqual({ status: "invalid" });
    expect(inspectDesktopCompatibilityAuthority(tempDir, Number.POSITIVE_INFINITY)).toEqual({ status: "invalid" });
    expect(inspectDesktopCompatibilityAuthority(tempDir, expectedTo - 1)).toMatchObject({
      status: "present",
      expiresAt: expectedTo,
    });
    expect(inspectDesktopCompatibilityAuthority(tempDir, expectedTo)).toMatchObject({
      status: "expired",
      expiresAt: expectedTo,
    });

    await expect(loadDesktopCompatibilityAuthority({ directory: tempDir, protection, now: () => Number.NaN }))
      .rejects.toMatchObject({ code: "unreadable" });
    await expect(loadDesktopCompatibilityAuthority({ directory: tempDir, protection, now: () => expectedFrom - 1 }))
      .rejects.toMatchObject({ code: "unreadable" });
    await expect(loadDesktopCompatibilityAuthority({ directory: tempDir, protection, now: () => expectedTo }))
      .rejects.toMatchObject({ code: "expired" });

    // Oversized CA validity (> 31 days) must fail validatedAuthority even when sealed cleanly.
    const longDir = join(tempDir, "long-lived");
    const commonName = `EasyProxy Codex Desktop ${randomUUID()}`;
    const basicConstraintsCa = Buffer.from("300f0603551d130101ff040530030101ff", "hex");
    const longCa = mintAuthorityWithExtensionsForTests(commonName, [basicConstraintsCa]);
    const clear = Buffer.from(JSON.stringify({
      policy: "codex-desktop-chatgpt-only/v1",
      certSha256: createHash("sha256").update(longCa.certPem).digest("hex"),
      commonName,
      keyPem: longCa.keyPem,
    }));
    const sealed = Buffer.from(await protection.protect(clear)).toString("base64");
    clear.fill(0);
    await ensureDesktopCompatibilityAuthority({ directory: longDir, protection });
    writeFileSync(join(longDir, "authority.json"), JSON.stringify({
      version: 1,
      protection: "windows-current-user-dpapi",
      certPem: longCa.certPem,
      sealed,
    }));
    expect(inspectDesktopCompatibilityAuthority(longDir).status).toBe("renewal-required");
    await expect(loadDesktopCompatibilityAuthority({ directory: longDir, protection }))
      .rejects.toMatchObject({ code: "unreadable" });

    // Corrupt ASN.1 UTCTime calendar overflow ("260230000000Z") in PEM fails closed in both inspect and load.
    const saved = JSON.parse(readFileSync(join(tempDir, "authority.json"), "utf8")) as {
      version: number;
      protection: string;
      certPem: string;
      sealed: string;
    };
    const der = Buffer.from(saved.certPem.replace(/-----.*?-----|\s+/g, ""), "base64");
    let validitySeq = der.indexOf(Buffer.from("301e170d", "hex"));
    while (validitySeq !== -1) {
      const notBeforeText = der.subarray(validitySeq + 4, validitySeq + 17).toString("ascii");
      const hasSecondUtc = der[validitySeq + 17] === 0x17 && der[validitySeq + 18] === 0x0d;
      const notAfterText = der.subarray(validitySeq + 19, validitySeq + 32).toString("ascii");
      if (/^\d{12}Z$/.test(notBeforeText) && hasSecondUtc && /^\d{12}Z$/.test(notAfterText)) break;
      validitySeq = der.indexOf(Buffer.from("301e170d", "hex"), validitySeq + 1);
    }
    expect(validitySeq).toBeGreaterThan(-1);
    der.write("260230000000Z", validitySeq + 19);
    saved.certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
    writeFileSync(join(tempDir, "authority.json"), JSON.stringify(saved));
    expect(inspectDesktopCompatibilityAuthority(tempDir)).toEqual({ status: "invalid" });
    await expect(loadDesktopCompatibilityAuthority({ directory: tempDir, protection }))
      .rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("mistral-transport retryDelay strict Retry-After guard", () => {
  test("ignores bad-1, calendar overflow, 24:00:00, and >128B Retry-After in pacer and same-target hold", async () => {
    const baseNow = Date.UTC(2026, 8, 9, 0, 0, 0);
    let now = baseNow;
    const waits: number[] = [];
    const pacer = new MistralBudgetPacer(
      () => now,
      async ms => {
        waits.push(ms);
        now += ms;
      },
    );

    const invalidHints = [
      "bad-1",
      "0x10",
      "-5",
      "2099-02-30T00:00:00Z",
      "2099-09-09T24:00:00Z",
      "30 Feb 2099 00:00:00 GMT",
      `2099-01-01T00:00:00.${"0".repeat(150)}Z`,
      "9".repeat(129),
    ];

    for (const hint of invalidHints) {
      pacer.observe("id", new Headers({ "retry-after": hint }), 429);
      (await pacer.acquire("id"))(true);
      expect(waits).toEqual([]);

      const transport = resolveMistralTransport(
        {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://api.mistral.ai/v1",
          apiKey: "synthetic-mistral-key",
          fetch: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": hint } })) as typeof fetch,
        },
        new MistralBudgetPacer(() => baseNow),
      );
      const response = await transport.fetch!("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-mistral-key" },
        body: JSON.stringify({ model: "mistral-large-4" }),
      });
      expect(isSameTargetRetryHold(response)).toBe(false);
    }

    // "bad-1" must resolve to undefined (not 0 from negative epoch delta), allowing minute fallback.
    pacer.observe(
      "minute",
      new Headers({
        "retry-after": "bad-1",
        "x-ratelimit-limit-tokens-minute": "1000",
        "x-ratelimit-remaining-tokens-minute": "400",
        "x-ratelimit-tokens-query-cost": "600",
      }),
      429,
    );
    (await pacer.acquire("minute"))(true);
    expect(waits).toEqual([60_000]);

    // Valid future ISO and legacy HTTP-date remain honored.
    const validTransport = resolveMistralTransport(
      {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.mistral.ai/v1",
        apiKey: "synthetic-mistral-key",
        fetch: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "2099-02-28T00:00:00Z" } })) as typeof fetch,
      },
      new MistralBudgetPacer(() => baseNow),
    );
    const validResp = await validTransport.fetch!("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-mistral-key" },
      body: JSON.stringify({ model: "mistral-large-4" }),
    });
    expect(isSameTargetRetryHold(validResp)).toBe(true);

    now = Date.UTC(2027, 9, 21, 7, 27, 50);
    waits.length = 0;
    pacer.observe("http-date", new Headers({ "retry-after": "Wed, 21 Oct 2027 07:28:00 GMT" }), 429);
    (await pacer.acquire("http-date"))(true);
    expect(waits).toEqual([10_000]);
  });
});

describe("telemetry state and profile sync reject bad-1, overflow, and >128B timestamps", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    setProfileClientOverridesForTests(null);
    if (tempDir) {
      removeTreeWithRetry(tempDir);
      tempDir = undefined;
    }
  });

  test("readTelemetryStateFile rejects malformed opt-out/decision fields and clears invalid retryAfterUntil", () => {
    tempDir = mkdtempSync(join(tmpdir(), "epx-telemetry-state-ts-"));
    const statePath = telemetryStatePath(tempDir);
    const base = { version: 1, sentDays: {} };
    const oversized = `2026-09-01T00:00:00.${"0".repeat(150)}Z`;

    for (const bad of [
      { ...base, ineligibleThroughDay: "2026-02-30" },
      { ...base, envOptOutActiveSince: "bad-1" },
      { ...base, envOptOutActiveSince: "2026-02-30T00:00:00Z" },
      { ...base, envOptOutActiveSince: "2026-09-09T24:00:00Z" },
      { ...base, envOptOutActiveSince: oversized },
      { ...base, envOptOutOwners: [{ pid: 123, since: "bad-1" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: "2026-02-30T00:00:00Z" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: "2026-09-09T24:00:00Z" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: oversized }] },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "bad-1" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "2026-02-30T00:00:00Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "2026-09-09T24:00:00Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: oversized } },
    ]) {
      writeFileSync(statePath, JSON.stringify(bad), "utf8");
      const read = readTelemetryStateFile(tempDir);
      expect(read.unreadable, JSON.stringify(bad)).toBe(true);
      expect(read.state.envOptOutOwners).toEqual([]);
    }

    for (const badRetry of ["bad-1", "2099-02-30T00:00:00Z", "2099-09-09T24:00:00Z", `2099-01-01T00:00:00.${"0".repeat(150)}Z`]) {
      writeFileSync(statePath, JSON.stringify({ ...base, retryAfterUntil: badRetry }), "utf8");
      const read = readTelemetryStateFile(tempDir);
      expect(read.unreadable).toBe(false);
      expect(read.state.retryAfterUntil).toBeNull();
    }

    writeFileSync(statePath, JSON.stringify({
      ...base,
      retryAfterUntil: "2099-02-28T00:00:00Z",
      pendingDecision: {
        decision: "accepted",
        decidedAt: "2026-11-01T00:00:00Z",
        noticeShownAt: "2026-02-30T00:00:00Z",
      },
    }), "utf8");
    const acceptedFallback = readTelemetryStateFile(tempDir);
    expect(acceptedFallback.unreadable).toBe(false);
    expect(acceptedFallback.state.retryAfterUntil).toBe("2099-02-28T00:00:00Z");
    expect(acceptedFallback.state.pendingDecision).toEqual({
      decision: "accepted",
      decidedAt: "2026-11-01T00:00:00Z",
      noticeShownAt: "2026-11-01T00:00:00Z",
    });

    writeFileSync(statePath, JSON.stringify({
      ...base,
      pendingDecision: {
        decision: "declined",
        decidedAt: "bad-1",
        noticeShownAt: "2026-02-30T00:00:00Z",
      },
    }), "utf8");
    const mtimeIso = statSync(statePath).mtime.toISOString();
    const declinedFallback = readTelemetryStateFile(tempDir);
    expect(declinedFallback.unreadable).toBe(false);
    expect(declinedFallback.state.pendingDecision).toEqual({
      decision: "declined",
      decidedAt: mtimeIso,
      noticeShownAt: mtimeIso,
    });
  });

  test("runProfileTick ignores bad-1, overflow, and >128B retryAfterUntil instead of sticking in backoff", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "epx-profile-sync-ts-"));
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    const secret = `epxp_${"B".repeat(43)}`;
    const readConfig = () => ({
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-10-01T00:00:00.000Z",
        noticeShownAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const aggregateDay = async (day: string) => ({
      day,
      activeMinutes: 5,
      requests: { completed: 1, failed: 0, incomplete: 0, aborted: 0 },
      errors: {},
      models: [{
        providerKind: "openai" as const,
        modelFamily: "gpt-5" as const,
        requests: 1,
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      }],
    });

    let calls = 0;
    setProfileClientOverridesForTests({
      baseUrl: "https://collector.test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (init?.method === "DELETE") return Response.json({ ok: true, deleted: true });
        return Response.json({ ok: true, deduplicated: false });
      }) as typeof fetch,
    });

    const writeProfile = (retryAfterUntil: string | null, pendingDelete = false) => {
      writeFileSync(telemetryProfilePath(tempDir!), JSON.stringify({
        version: 1,
        handle: "alice-dev",
        displayName: "Alice",
        avatar: "blue",
        secret,
        connectedAt: "2026-11-05T10:00:00.000Z",
        connectedDay: "2026-11-05",
        sentDays: {},
        lastSentDay: null,
        lastSentAt: null,
        retryAfterUntil,
        pendingDelete,
        revoked: false,
      }));
    };

    // Valid future retryAfterUntil enforces backoff without sending.
    writeProfile("2099-01-01T00:00:00.000Z");
    expect(await runProfileTick({ configDir: tempDir, env: {}, now, readConfig, aggregateDay })).toEqual({
      sent: false,
      reason: "retry-after-backoff",
    });
    expect(calls).toBe(0);

    for (const badRetry of [
      "bad-1",
      "2099-02-30T00:00:00Z",
      "2099-09-09T24:00:00Z",
      `2099-01-01T00:00:00.${"0".repeat(150)}Z`,
    ]) {
      writeProfile(badRetry, false);
      const tick = await runProfileTick({ configDir: tempDir, env: {}, now, readConfig, aggregateDay });
      expect(tick).toEqual({ sent: true, day: "2026-11-06", reason: "sent" });
    }
    expect(calls).toBe(4);

    // Pending delete with calendar-overflow retryAfterUntil must not stay stuck until 2099.
    writeProfile("2099-02-30T00:00:00Z", true);
    expect(await runProfileTick({ configDir: tempDir, env: {}, now, readConfig })).toEqual({
      sent: false,
      deleted: true,
      reason: "deleted",
    });
    expect(calls).toBe(5);
  });
});
