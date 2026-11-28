import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from "node:crypto";
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
import { resolveNextEligibleTelemetryDay, runTelemetryTick, type TelemetryState } from "../../src/telemetry/scheduler";
import { readTelemetryStateFile, telemetryStatePath } from "../../src/telemetry/state";
import { parseRetryAfterMs as parseTelemetryRetryAfterMs } from "../../src/telemetry/sender";
import { readTelemetryInstallId, telemetryIdPath } from "../../src/telemetry/install-id";
import { setProfileClientOverridesForTests } from "../../src/telemetry/profile/client";
import { readTelemetryProfileFile } from "../../src/telemetry/profile/state";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import { isProfileRetryAfterActive, runProfileTick } from "../../src/telemetry/profile/sync";
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

  function mintSignedCaWithValidity(
    commonName: string,
    notBefore: { tag: 0x17 | 0x18; text: string },
    notAfter: { tag: 0x17 | 0x18; text: string },
  ): { certPem: string; keyPem: string } {
    const tlv = (tag: number, body: Uint8Array): Buffer => {
      const len = body.length < 0x80
        ? [body.length]
        : body.length < 256
          ? [0x81, body.length]
          : [0x82, body.length >> 8, body.length & 0xff];
      return Buffer.concat([Buffer.from([tag, ...len]), body]);
    };
    const seq = (...parts: Uint8Array[]) => tlv(0x30, Buffer.concat(parts));
    const oid = (bytes: number[]) => tlv(0x06, Buffer.from(bytes));
    const alg = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const dn = seq(tlv(0x31, seq(oid([0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(commonName)))));
    const basicConstraintsCa = Buffer.from("300f0603551d130101ff040530030101ff", "hex");
    const serverAuthEku = Buffer.from("30160603551d250101ff040c300a06082b06010505070301", "hex");
    const tbs = seq(
      tlv(0xa0, tlv(0x02, Buffer.from([2]))),
      tlv(0x02, Buffer.from([1])),
      alg,
      dn,
      seq(tlv(notBefore.tag, Buffer.from(notBefore.text)), tlv(notAfter.tag, Buffer.from(notAfter.text))),
      dn,
      spki,
      tlv(0xa3, seq(basicConstraintsCa, serverAuthEku)),
    );
    const sig = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
    const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
    const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END CERTIFICATE-----\n`;
    return { certPem, keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  }

  async function writeProtectedAuthority(
    dir: string,
    protection: AuthorityKeyProtection,
    certPem: string,
    keyPem: string,
    commonName: string,
  ): Promise<void> {
    const clear = Buffer.from(JSON.stringify({
      policy: "codex-desktop-chatgpt-only/v1",
      certSha256: createHash("sha256").update(certPem).digest("hex"),
      commonName,
      keyPem,
    }));
    const sealed = Buffer.from(await protection.protect(clear)).toString("base64");
    clear.fill(0);
    await ensureDesktopCompatibilityAuthority({ directory: dir, protection });
    writeFileSync(join(dir, "authority.json"), JSON.stringify({
      version: 1,
      protection: "windows-current-user-dpapi",
      certPem,
      sealed,
    }));
  }

  test("inspectDesktopCompatibilityAuthority and validatedAuthority check validFromDate/validToDate, GeneralizedTime, inverted validity, and corrupt X.509 dates", async () => {
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

    // Oversized CA validity (> 31 days) with serverAuth EKU stays "present" in inspect but fails validatedAuthority as unreadable.
    const longDir = join(tempDir, "long-lived");
    const commonName = `EasyProxy Codex Desktop ${randomUUID()}`;
    const basicConstraintsCa = Buffer.from("300f0603551d130101ff040530030101ff", "hex");
    const serverAuthEku = Buffer.from("30160603551d250101ff040c300a06082b06010505070301", "hex");
    const longCa = mintAuthorityWithExtensionsForTests(commonName, [basicConstraintsCa, serverAuthEku]);
    await writeProtectedAuthority(longDir, protection, longCa.certPem, longCa.keyPem, commonName);
    expect(inspectDesktopCompatibilityAuthority(longDir).status).toBe("present");
    await expect(loadDesktopCompatibilityAuthority({ directory: longDir, protection }))
      .rejects.toMatchObject({ code: "unreadable" });

    // Valid RFC 5280 GeneralizedTime (year >= 2050) parses identically via validFromDate/validToDate.
    const genDir = join(tempDir, "generalized-time");
    const genName = `EasyProxy Codex Desktop ${randomUUID()}`;
    const genCa = mintSignedCaWithValidity(
      genName,
      { tag: 0x18, text: "20500101000000Z" },
      { tag: 0x18, text: "20500115000000Z" },
    );
    await writeProtectedAuthority(genDir, protection, genCa.certPem, genCa.keyPem, genName);
    expect(inspectDesktopCompatibilityAuthority(genDir, Date.UTC(2050, 0, 2))).toMatchObject({
      status: "present",
      expiresAt: Date.UTC(2050, 0, 15),
    });
    const loadedGen = await loadDesktopCompatibilityAuthority({ directory: genDir, protection, now: () => Date.UTC(2050, 0, 2) });
    expect(loadedGen.expiresAt).toBe(Date.UTC(2050, 0, 15));

    // Validly-signed CA with inverted validity (validFrom > validTo) must fail closed even under allowExpiredForRemoval=true.
    const invDir = join(tempDir, "inverted-validity");
    const invName = `EasyProxy Codex Desktop ${randomUUID()}`;
    const invCa = mintSignedCaWithValidity(
      invName,
      { tag: 0x17, text: "261101000000Z" },
      { tag: 0x17, text: "261001000000Z" },
    );
    await writeProtectedAuthority(invDir, protection, invCa.certPem, invCa.keyPem, invName);
    expect(inspectDesktopCompatibilityAuthority(invDir, Date.UTC(2026, 8, 1))).toEqual({ status: "invalid" });
    expect(inspectDesktopCompatibilityAuthority(invDir, Date.UTC(2026, 10, 2))).toEqual({ status: "invalid" });
    await expect(loadDesktopCompatibilityAuthority({ directory: invDir, protection, now: () => Date.UTC(2026, 10, 2) }))
      .rejects.toMatchObject({ code: "unreadable" });
    await expect(loadDesktopCompatibilityAuthority({ directory: invDir, protection, now: () => Date.UTC(2026, 10, 2) }, true))
      .rejects.toMatchObject({ code: "unreadable" });

    // Corrupt ASN.1 UTCTime calendar overflow ("260230000000Z") fails closed across X509Certificate DER decode and store checks.
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
  test("ignores bad-1, bad-9999, calendar overflow, 24:00:00, and >128B Retry-After in pacer, stateful transport, and same-target hold", async () => {
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
      "bad-9999",
      "0x10",
      "-5",
      "+5",
      "1e2",
      "2099-02-30T00:00:00Z",
      "2099-09-09T24:00:00Z",
      "30 Feb 2099 00:00:00 GMT",
      `2099-01-01T00:00:00.${"0".repeat(150)}Z`,
      "9".repeat(129),
    ];

    const sharedWaits: number[] = [];
    const sharedPacer = new MistralBudgetPacer(
      () => baseNow,
      async ms => {
        sharedWaits.push(ms);
      },
    );

    for (const hint of invalidHints) {
      pacer.observe("id", new Headers({ "retry-after": hint }), 429);
      (await pacer.acquire("id"))(true);
      expect(waits).toEqual([]);

      // Status 200 with remaining=0 also enters retryDelay and must ignore invalid hints.
      pacer.observe("id-200", new Headers({ "x-ratelimit-remaining-tokens-minute": "0", "retry-after": hint }), 200);
      (await pacer.acquire("id-200"))(true);
      expect(waits).toEqual([]);

      let upstreamCalls = 0;
      const transport = resolveMistralTransport(
        {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://api.mistral.ai/v1",
          apiKey: "synthetic-mistral-key",
          fetch: (async () => {
            upstreamCalls += 1;
            if (upstreamCalls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": hint } });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as typeof fetch,
        },
        sharedPacer,
      );
      const first = await transport.fetch!("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-mistral-key" },
        body: JSON.stringify({ model: "mistral-large-4" }),
      });
      expect(isSameTargetRetryHold(first)).toBe(false);
      // Reusing the same pacer must allow the follow-up send immediately with zero wait.
      const second = await transport.fetch!("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-mistral-key" },
        body: JSON.stringify({ model: "mistral-large-4" }),
      });
      expect(second.status).toBe(200);
      expect(sharedWaits).toEqual([]);
    }

    // "bad-1" and "bad-9999" must resolve to undefined (not 0 or year 9999), allowing minute fallback.
    for (const badToken of ["bad-1", "bad-9999"]) {
      waits.length = 0;
      pacer.observe(
        `minute-${badToken}`,
        new Headers({
          "retry-after": badToken,
          "x-ratelimit-limit-tokens-minute": "1000",
          "x-ratelimit-remaining-tokens-minute": "400",
          "x-ratelimit-tokens-query-cost": "600",
        }),
        429,
      );
      (await pacer.acquire(`minute-${badToken}`))(true);
      expect(waits).toEqual([60_000]);
    }

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

describe("telemetry state and profile sync reject bad-1, bad-9999, overflow, and >128B timestamps", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    setProfileClientOverridesForTests(null);
    if (tempDir) {
      removeTreeWithRetry(tempDir);
      tempDir = undefined;
    }
  });

  test("readTelemetryStateFile rejects malformed opt-out/decision fields and runTelemetryTick ignores invalid retryAfterUntil", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "epx-telemetry-state-ts-"));
    const statePath = telemetryStatePath(tempDir);
    const base = { version: 1, sentDays: {} };
    const oversized = `2026-09-01T00:00:00.${"0".repeat(150)}Z`;

    for (const bad of [
      { ...base, ineligibleThroughDay: "2026-02-30" },
      { ...base, envOptOutActiveSince: "bad-1" },
      { ...base, envOptOutActiveSince: "bad-9999" },
      { ...base, envOptOutActiveSince: "2026-02-30T00:00:00Z" },
      { ...base, envOptOutActiveSince: "2026-09-09T24:00:00Z" },
      { ...base, envOptOutActiveSince: oversized },
      { ...base, envOptOutOwners: "not-an-array" },
      { ...base, envOptOutOwners: [{ pid: 0, since: "2026-09-01T00:00:00Z" }] },
      { ...base, envOptOutOwners: Array.from({ length: 65 }, (_, i) => ({ pid: i + 1, since: "2026-09-01T00:00:00Z" })) },
      { ...base, envOptOutOwners: [{ pid: 123, since: "bad-1" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: "bad-9999" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: "2026-02-30T00:00:00Z" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: "2026-09-09T24:00:00Z" }] },
      { ...base, envOptOutOwners: [{ pid: 123, since: oversized }] },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "bad-1" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "bad-9999" } },
      { ...base, pendingDecision: { decision: "accepted", noticeShownAt: "2026-11-01T00:00:00Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "2026-02-30T00:00:00Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "2026-09-09T24:00:00Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: oversized } },
    ]) {
      writeFileSync(statePath, JSON.stringify(bad), "utf8");
      const read = readTelemetryStateFile(tempDir);
      expect(read.unreadable, JSON.stringify(bad)).toBe(true);
      expect(read.state.envOptOutOwners).toEqual([]);
    }

    for (const badRetry of ["bad-1", "bad-9999", "2099-02-30T00:00:00Z", "2099-09-09T24:00:00Z", `2099-01-01T00:00:00.${"0".repeat(150)}Z`]) {
      writeFileSync(statePath, JSON.stringify({ ...base, retryAfterUntil: badRetry }), "utf8");
      const read = readTelemetryStateFile(tempDir);
      expect(read.unreadable).toBe(false);
      expect(read.state.retryAfterUntil).toBeNull();
    }

    // runTelemetryTick must not enter retry-after-backoff when retryAfterUntil is bad-9999 or calendar overflow.
    writeFileSync(statePath, JSON.stringify({ ...base, retryAfterUntil: "2099-02-30T00:00:00Z" }), "utf8");
    const tick = await runTelemetryTick({
      configDir: tempDir,
      env: {},
      now: Date.parse("2026-11-07T12:00:00.000Z"),
      readConfig: () => ({
        telemetry: {
          decision: "accepted",
          decidedAt: "2026-11-07T00:00:00.000Z",
          noticeShownAt: "2026-11-07T00:00:00.000Z",
        },
      }),
    });
    expect(tick).toEqual({ sent: false, reason: "up-to-date" });

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

  test("isProfileRetryAfterActive and runProfileTick ignore bad-1, bad-9999, overflow, and >128B retryAfterUntil", async () => {
    // Directly exercise sync.ts's retryAfterUntil guard (readTelemetryProfileFile pre-strips disk files).
    const year2000 = Date.UTC(2000, 0, 1);
    const year2026 = Date.UTC(2026, 10, 7);
    expect(isProfileRetryAfterActive("bad-1", year2000)).toBe(false);
    expect(isProfileRetryAfterActive("bad-9999", year2026)).toBe(false);
    expect(isProfileRetryAfterActive("2099-02-30T00:00:00Z", year2026)).toBe(false);
    expect(isProfileRetryAfterActive("2099-09-09T24:00:00Z", year2026)).toBe(false);
    expect(isProfileRetryAfterActive(`2099-01-01T00:00:00.${"0".repeat(150)}Z`, year2026)).toBe(false);
    expect(isProfileRetryAfterActive("2099-01-01T00:00:00Z", Number.NaN)).toBe(false);
    expect(isProfileRetryAfterActive("2099-01-01T00:00:00Z", year2026)).toBe(true);
    expect(isProfileRetryAfterActive("2026-11-07T00:00:00Z", year2026)).toBe(false);

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
      "bad-9999",
      "2099-02-30T00:00:00Z",
      "2099-09-09T24:00:00Z",
      `2099-01-01T00:00:00.${"0".repeat(150)}Z`,
    ]) {
      writeProfile(badRetry, false);
      const tick = await runProfileTick({ configDir: tempDir, env: {}, now, readConfig, aggregateDay });
      expect(tick).toEqual({ sent: true, day: "2026-11-06", reason: "sent" });
    }
    expect(calls).toBe(5);

    // Pending delete with calendar-overflow retryAfterUntil must not stay stuck until 2099.
    writeProfile("2099-02-30T00:00:00Z", true);
    expect(await runProfileTick({ configDir: tempDir, env: {}, now, readConfig })).toEqual({
      sent: false,
      deleted: true,
      reason: "deleted",
    });
    expect(calls).toBe(6);
  });
});
