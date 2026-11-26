import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import {
  acquireApiKeyBudgetLease,
  getApiKeyBudgetHoldSnapshot,
  resetApiKeyBudgetsForTests,
} from "../../src/server/api-key-budget";
import {
  estimateBudgetReservationForTurn,
  reservePreDispatchApiKeyHold,
} from "../../src/server/api-key-budget-estimate";
import {
  requestBodyFactsHolder,
  requestBodyLogField,
} from "../../src/server/request-body-facts";
import { MAX_DECOMPRESSED_BODY_BYTES, readBoundedJsonRequestBody } from "../../src/server/request-decompress";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { ADMISSION_TOLERANCE, checkInputAdmission } from "../../src/server/responses/input-admission";
import type { EpxConfig, EpxParsedRequest } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { settleServerAuthFixture, startManagementServerFixture } from "../helpers/server-auth-fixture";

describe("dense non-whitespace ASCII fallback budget hold", () => {
  const homes: string[] = [];
  const origHome = process.env.EASYPROXY_HOME;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "epx-dense-ascii-hold-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;
    resetApiKeyBudgetsForTests();
    clearRequestLogsForTests();
  });

  afterEach(async () => {
    resetApiKeyBudgetsForTests();
    clearRequestLogsForTests();
    if (origHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origHome;
    while (homes.length > 0) removeTreeWithRetry(homes.pop()!);
  });

  test("bumps fallback reservation for dense >=256-byte ASCII while preserving small, spaced, and explicit-estimate turns", () => {
    const baseSmall = estimateBudgetReservationForTurn({
      providerName: "p",
      modelId: "gpt-5",
      decodedBytes: 80,
      nonWhitespaceAsciiBytes: 80,
      maxOutputTokens: 10,
    });
    expect(baseSmall.estimatedTokens).toBe(Math.ceil(80 / 4) + 10);

    const spacedProse = estimateBudgetReservationForTurn({
      providerName: "p",
      modelId: "gpt-5",
      decodedBytes: 400,
      nonWhitespaceAsciiBytes: 310, // 77.5% < 85%
      maxOutputTokens: 10,
    });
    expect(spacedProse.estimatedTokens).toBe(Math.ceil(400 / 4) + 10);

    const denseAscii = estimateBudgetReservationForTurn({
      providerName: "p",
      modelId: "gpt-5",
      decodedBytes: 400,
      nonWhitespaceAsciiBytes: 390, // 97.5% >= 85%
      maxOutputTokens: 10,
    });
    expect(denseAscii.estimatedTokens).toBe(Math.ceil(390 / 2) + 10);

    // Defensive clamp if caller supplies nonWhitespaceAsciiBytes > decodedBytes.
    const clampedDense = estimateBudgetReservationForTurn({
      providerName: "p",
      modelId: "gpt-5",
      decodedBytes: 400,
      nonWhitespaceAsciiBytes: 999_999,
      maxOutputTokens: 10,
    });
    expect(clampedDense.estimatedTokens).toBe(Math.ceil(400 / 2) + 10);

    // Explicit estimatedInputTokens still takes precedence over byte heuristics.
    const explicit = estimateBudgetReservationForTurn({
      providerName: "p",
      modelId: "gpt-5",
      decodedBytes: 400,
      nonWhitespaceAsciiBytes: 400,
      estimatedInputTokens: 42,
      maxOutputTokens: 10,
    });
    expect(explicit.estimatedTokens).toBe(52);
  });

  test("readBoundedJsonRequestBody records non-persisted dense ASCII count without altering log facts or admission gate", async () => {
    expect(ADMISSION_TOLERANCE).toBe(2.5);
    const densePayload = JSON.stringify({ model: "p/m", input: "A1B2C3D4".repeat(60) });
    const req = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: densePayload,
    });
    const holder = requestBodyFactsHolder(req);
    await readBoundedJsonRequestBody(req, MAX_DECOMPRESSED_BODY_BYTES);

    expect(holder.facts?.decodedBytes).toBe(Buffer.byteLength(densePayload));
    expect(holder.nonWhitespaceAsciiBytes).toBe(Buffer.byteLength(densePayload));
    const logged = requestBodyLogField({ requestBodyHolder: holder });
    expect("nonWhitespaceAsciiBytes" in (logged.requestBody ?? {})).toBe(false);

    // Admission tolerance remains independent and unchanged.
    const parsedForAdmission = {
      modelId: "gpt-5",
      stream: false,
      context: {
        messages: [{ role: "user", timestamp: 0, content: [{ type: "text", text: "A1B2C3D4".repeat(60) }] }],
      },
      options: {},
    } as EpxParsedRequest;
    const admitted = checkInputAdmission(
      parsedForAdmission,
      { adapter: "openai-responses", baseUrl: "https://example.test/v1", contextWindow: 100 },
      "p",
      "gpt-5",
    );
    expect(admitted.estimatedTokens).toBe(Math.ceil(("A1B2C3D4".repeat(60)).length / 4));
    expect(admitted.admitted).toBe(admitted.estimatedTokens <= 100 * ADMISSION_TOLERANCE);

    // Fallback hold uses holder nonWhitespaceAsciiBytes and denies under tight tpmLimit.
    const tightKey = {
      id: "dense-hold-key",
      name: "dense-hold-key",
      key: "epx_data_densehold000001",
      createdAt: "2026-11-26T00:00:00Z",
      tpmLimit: 200,
    };
    const leaseRes = acquireApiKeyBudgetLease(tightKey);
    expect(leaseRes.allowed).toBe(true);
    if (!leaseRes.allowed) return;
    const cfg: EpxConfig = { ...getDefaultConfig(), apiKeys: [tightKey] };
    const refusal = await reservePreDispatchApiKeyHold({
      req,
      config: cfg,
      logCtx: {
        model: "p/m",
        provider: "p",
        admissionKind: "configured",
        apiKeyId: tightKey.id,
        apiKeyBudgetLease: leaseRes.lease,
        requestBodyHolder: holder,
      },
      providerName: "p",
      modelId: "gpt-5",
      maxOutputTokens: 10,
    });
    expect(refusal?.status).toBe(429);
    expect(getApiKeyBudgetHoldSnapshot(tightKey.id).rpmCurrent).toBe(0);
  });

  test("enforces dense ASCII pre-dispatch hold on live /v1/responses route while allowing spaced text of equal byte size", async () => {
    const serverHome = mkdtempSync(join(tmpdir(), "epx-dense-ascii-srv-"));
    homes.push(serverHome);
    let upstreamHits = 0;
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        upstreamHits += 1;
        return Response.json({
          id: "resp_dense_ok",
          object: "response",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        });
      },
    });
    const denseKey = {
      id: "live-dense-key",
      name: "live-dense-key",
      key: "epx_data_livedense000001",
      createdAt: "2026-11-26T00:00:00Z",
      rpmLimit: 10,
      tpmLimit: 240,
    };
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      defaultProvider: "p1",
      apiKeys: [denseKey],
      providers: {
        p1: {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-p1",
          models: ["m1"],
        },
      },
    };
    const fixture = await startManagementServerFixture(serverHome, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // ~540 bytes of dense non-whitespace ASCII -> ceil(~540/2)+10 = ~280 > tpmLimit 240 -> 429 before upstream.
      const denseInput = "X9yZ".repeat(125);
      const denseResp = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": denseKey.key,
        },
        body: JSON.stringify({ model: "p1/m1", input: denseInput, max_output_tokens: 10, stream: false }),
      });
      expect(denseResp.status).toBe(429);
      const denseErr = await denseResp.json() as { error?: { code?: string } };
      expect(denseErr.error?.code).toBe("tpm_limit_exceeded");
      expect(upstreamHits).toBe(0);

      // Equal ~540-byte spaced prose (< 85% non-whitespace ASCII) keeps ceil(~540/4)+10 = ~145 <= 240 -> 200.
      const spacedInput = "word ".repeat(100);
      const spacedResp = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": denseKey.key,
        },
        body: JSON.stringify({ model: "p1/m1", input: spacedInput, max_output_tokens: 10, stream: false }),
      });
      expect(spacedResp.status).toBe(200);
      expect(upstreamHits).toBe(1);
    } finally {
      await fixture.close();
      upstream.stop(true);
      await settleServerAuthFixture(serverHome);
    }
  });
});
