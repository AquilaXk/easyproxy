import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseStrictTimestampMs } from "../../src/lib/strict-timestamp";
import {
  commitApiKeyRotation,
  removeExpiredApiKeyRotations,
  startApiKeyRotation,
} from "../../src/server/management/api-key-rotation";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import { resolveNextEligibleTelemetryDay, type TelemetryState } from "../../src/telemetry/scheduler";
import { retryAfterDelayMs } from "../../src/lib/upstream-retry";
import { parseRetryAfterMs as parseCodexRetryAfterMs } from "../../src/codex/routing/cooldown-math";
import { parseQuotaResetAt } from "../../src/providers/key-failover";
import { applyApiKeyBudgetPatch } from "../../src/server/management/api-key-budget-dto";
import { isApiKeyExpired } from "../../src/server/auth-cors";
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
});
