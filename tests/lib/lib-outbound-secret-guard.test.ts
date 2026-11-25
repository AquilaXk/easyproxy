import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig } from "../../src/config";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import {
  inspectAndApplyOutboundSecretGuard,
  MAX_SECRET_SCAN_BYTES,
  MAX_SECRET_SCAN_DEPTH,
} from "../../src/lib/outbound-secret-guard";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { handleManagementAPI } from "../../src/server/management-api";
import { ANTHROPIC_ERROR_CODES, OPENAI_ERROR_CODES } from "../../src/lib/client-error-body";
import { normalizeLogErrorCode } from "../../src/usage/error-detail";
import {
  applyOutboundPayloadHygiene,
  getOutboundHygieneStats,
  resetOutboundHygieneStatsForTests,
} from "../../src/server/outbound-payload-hygiene";
import { saveConfig } from "../../src/config";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Construct synthetic token shapes dynamically so source files never contain literal credential strings.
const fakeGhToken = () => ["ghp", "1234567890abcdefghij123456"].join("_");
const fakeOpenAiKey = () => ["sk", "proj", "1234567890abcdefghijklmnop"].join("-");
const fakeAnthropicKey = () => ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz"].join("-");
const fakeAwsKey = () => "AKIA" + "IOSFODNN7EXAMPLE";
const fakeGoogleKey = () => "AIza" + "SyDaGmWKa4JsXZ-HjGw7ISLn_3namBG6623";
const fakeEpxToken = () => ["epx", "data", "0123456789abcdef01"].join("_");
const fakePemKey = () => [
  "-----BEGIN RSA " + "PRIVATE KEY-----",
  "MIIBOgIBAAJBALe",
  "-----END RSA " + "PRIVATE KEY-----",
].join("\n");

describe("outbound-secret-guard", () => {
  test("passes payloads untouched when mode is off", () => {
    const token = fakeGhToken();
    const payload = { input: [{ role: "user", content: token }] };
    const result = inspectAndApplyOutboundSecretGuard(payload, { mode: "off" });
    expect(result.blocked).toBe(false);
    expect(result.matches).toBe(0);
    expect(payload.input[0]!.content).toBe(token);
  });

  test("redacts multiple secret formats in-place when mode is redact", () => {
    const awsKey = fakeAwsKey();
    const payload = {
      input: [
        {
          role: "user",
          content: [
            `openai=${fakeOpenAiKey()}`,
            `anth=${fakeAnthropicKey()}`,
            `gh=${fakeGhToken()}`,
            `aws=${awsKey}`,
            `gcp=${fakeGoogleKey()}`,
            `epx=${fakeEpxToken()}`,
            `pem=${fakePemKey()}`,
          ].join(" "),
        },
      ],
    };

    const result = inspectAndApplyOutboundSecretGuard(payload, { mode: "redact" });
    expect(result.blocked).toBe(false);
    expect(result.matches).toBeGreaterThanOrEqual(7);
    expect(result.redactions).toBeGreaterThanOrEqual(7);
    expect(result.findings).toEqual(
      expect.arrayContaining(["openai_key", "anthropic_key", "github_token", "aws_access_key", "google_api_key", "easyproxy_token", "pem_private_key"]),
    );
    const sanitized = payload.input[0]!.content;
    expect(sanitized).toContain("[REDACTED:openai_key]");
    expect(sanitized).toContain("[REDACTED:anthropic_key]");
    expect(sanitized).toContain("[REDACTED:github_token]");
    expect(sanitized).toContain("[REDACTED:aws_access_key]");
    expect(sanitized).toContain("[REDACTED:google_api_key]");
    expect(sanitized).toContain("[REDACTED:easyproxy_token]");
    expect(sanitized).toContain("[REDACTED:pem_private_key]");
    expect(sanitized).not.toContain(awsKey);
  });

  test("redacts and blocks admin, session, and pair easyproxy tokens", () => {
    const adminToken = ["epx", "admin", "0123456789abcdef01"].join("_");
    const sessionToken = ["epx", "session", "0123456789abcdef01"].join("_");
    const pairToken = ["epx", "pair", "0123456789abcdef01"].join("_");

    for (const token of [adminToken, sessionToken, pairToken]) {
      const blocked = inspectAndApplyOutboundSecretGuard({ input: token }, { mode: "block" });
      expect(blocked.blocked).toBe(true);
      expect(blocked.matches).toBe(1);
      expect(blocked.findings).toContain("easyproxy_token");

      const payload = { input: `auth=${token}` };
      const redacted = inspectAndApplyOutboundSecretGuard(payload, { mode: "redact" });
      expect(redacted.blocked).toBe(false);
      expect(redacted.redactions).toBe(1);
      expect(payload.input).toBe("auth=[REDACTED:easyproxy_token]");
    }
  });

  test("blocks request without mutating payload when mode is block", () => {
    const secret = fakeOpenAiKey();
    const payload = { input: secret };
    const result = inspectAndApplyOutboundSecretGuard(payload, { mode: "block" });
    expect(result.blocked).toBe(true);
    expect(result.matches).toBe(1);
    expect(result.redactions).toBe(0);
    expect(payload.input).toBe(secret);
  });

  test("fails closed in block mode when byte or depth traversal limits are exceeded and handles cycles", () => {
    let deep: Record<string, unknown> = { text: "safe" };
    for (let i = 0; i <= MAX_SECRET_SCAN_DEPTH + 2; i += 1) {
      deep = { child: deep };
    }
    const deepBlock = inspectAndApplyOutboundSecretGuard(deep, { mode: "block" });
    expect(deepBlock.blocked).toBe(true);
    expect(deepBlock.limitExceeded).toBe(true);
    expect(deepBlock.findings).toContain("scan_budget_exceeded");

    const huge = { chunk1: "A".repeat(MAX_SECRET_SCAN_BYTES / 2 + 1024), chunk2: "B".repeat(MAX_SECRET_SCAN_BYTES / 2 + 1024) };
    const byteBlock = inspectAndApplyOutboundSecretGuard(huge, { mode: "block" });
    expect(byteBlock.blocked).toBe(true);
    expect(byteBlock.limitExceeded).toBe(true);

    const cyclic: Record<string, unknown> = { text: `token ${fakeEpxToken()}` };
    cyclic.self = cyclic;
    const cyclicRedact = inspectAndApplyOutboundSecretGuard(cyclic, { mode: "redact" });
    expect(cyclicRedact.blocked).toBe(false);
    expect(cyclic.text).toBe("token [REDACTED:easyproxy_token]");
  });

  test("degrades malformed persisted outboundSecretGuard fail-closed to block and rejects invalid writes", () => {
    const prevHome = process.env.EASYPROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "epx-secret-guard-cfg-"));
    try {
      process.env.EASYPROXY_HOME = home;
      writeFileSync(join(home, "config.json"), JSON.stringify({
        ...getDefaultConfig(),
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "k-valid", models: ["m"] },
        },
        outboundSecretGuard: { mode: "blokc" },
      }), "utf8");
      const loaded = loadConfig();
      expect(loaded.outboundSecretGuard).toEqual({ mode: "block" });
      expect(loaded.providers.custom?.baseUrl).toBe("https://example.invalid/v1");
    } finally {
      if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = prevHome;
      removeTreeWithRetry(home);
    }

    const badGuard = validateConfigCandidate({ ...getDefaultConfig(), outboundSecretGuard: { mode: "blokc" } });
    expect(badGuard.ok).toBe(false);
    const badCompress = validateConfigCandidate({ ...getDefaultConfig(), toolOutputCompression: { minChars: 10 } });
    expect(badCompress.ok).toBe(false);
    const badBudget = validateConfigCandidate({
      ...getDefaultConfig(),
      apiKeys: [{ id: "k1", name: "k1", key: "epx_data_valid_key_123456", createdAt: new Date().toISOString(), rpmLimit: 0 }],
    });
    expect(badBudget.ok).toBe(false);
    const badTokenZero = validateConfigCandidate({
      ...getDefaultConfig(),
      apiKeys: [{ id: "k1", name: "k1", key: "epx_data_valid_key_123456", createdAt: new Date().toISOString(), dailyTokenLimit: 0 }],
    });
    expect(badTokenZero.ok).toBe(false);
    const badTokenOver = validateConfigCandidate({
      ...getDefaultConfig(),
      apiKeys: [{ id: "k1", name: "k1", key: "epx_data_valid_key_123456", createdAt: new Date().toISOString(), dailyTokenLimit: 10_000_000_001 }],
    });
    expect(badTokenOver.ok).toBe(false);
  });

  test("blocks secrets before upstream dispatch on native chat, messages, and compact lanes", async () => {
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const secret = fakeOpenAiKey();
      const baseConfig = {
        ...getDefaultConfig(),
        outboundSecretGuard: { mode: "block" as const },
        providers: {
          openai: { adapter: "openai-responses" as const, baseUrl: "https://api.openai.com/v1", apiKey: "k-oai", models: ["gpt-5.3-codex"] },
          "openai-chat": { adapter: "openai-chat" as const, baseUrl: "https://chat.example.invalid/v1", apiKey: "k-chat", models: ["gpt-4o"] },
          anthropic: { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "k-ant", models: ["claude-sonnet-4-5"] },
        },
      };

      const chatRes = await handleChatCompletions(
        new Request("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai-chat/gpt-4o", messages: [{ role: "user", content: `leak ${secret}` }] }),
        }),
        baseConfig,
        { model: "gpt-4o", provider: "openai-chat" },
      );
      expect(chatRes.status).toBe(400);
      const chatText = await chatRes.text();
      expect(chatText).not.toContain(secret);
      expect(JSON.parse(chatText)).toMatchObject({
        error: { type: "invalid_request_error", code: "outbound_secret_guard" },
      });

      const msgRes = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "k-ant" },
          body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: `leak ${secret}` }] }),
        }),
        baseConfig,
        { model: "claude-sonnet-4-5", provider: "anthropic" },
      );
      expect(msgRes.status).toBe(400);
      const msgText = await msgRes.text();
      expect(msgText).not.toContain(secret);
      expect(JSON.parse(msgText)).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error", code: "outbound_secret_guard" },
      });

      const compactRes = await handleResponsesCompact(
        new Request("http://127.0.0.1/v1/responses/compact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.3-codex", input: [{ role: "user", content: `leak ${secret}` }] }),
        }),
        baseConfig,
        { model: "gpt-5.3-codex", provider: "openai" },
      );
      expect(compactRes.status).toBe(400);
      const compactText = await compactRes.text();
      expect(compactText).not.toContain(secret);
      expect(JSON.parse(compactText)).toMatchObject({
        error: { type: "invalid_request_error" },
      });
      expect(OPENAI_ERROR_CODES.has("outbound_secret_guard")).toBe(true);
      expect(ANTHROPIC_ERROR_CODES.has("outbound_secret_guard")).toBe(true);
      expect(normalizeLogErrorCode("outbound_secret_guard", 400)).toBe("outbound_secret_guard");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("16K-bit pair bitmap skips benign payloads and rejects O(1) oversized strings fail-closed", () => {
    const clean = { input: [{ role: "user", content: "ordinary prompt ".repeat(4000) }] };
    const cleanRes = inspectAndApplyOutboundSecretGuard(clean, { mode: "block" });
    expect(cleanRes.blocked).toBe(false);
    expect(cleanRes.matches).toBe(0);

    // Every rule prefix + multi-byte non-ASCII neighbors still match through the bitmap prefilter.
    const slackToken = ["xoxb", "1234567890", "abcdefghij"].join("-");
    const unicodePayload = { text: `한글과 함께 ${slackToken} 포함` };
    expect(inspectAndApplyOutboundSecretGuard(unicodePayload, { mode: "block" }).blocked).toBe(true);

    // O(1) length reject before byte measurement when string.length exceeds MAX_SECRET_SCAN_BYTES.
    const huge = { giant: "a".repeat(MAX_SECRET_SCAN_BYTES + 1) };
    const overRes = inspectAndApplyOutboundSecretGuard(huge, { mode: "block" });
    expect(overRes.blocked).toBe(true);
    expect(overRes.limitExceeded).toBe(true);
  });

  test("GET and PUT /api/gateway-guardrails persist validated policy and report live hygiene counters", async () => {
    resetOutboundHygieneStatsForTests();
    const prevHome = process.env.EASYPROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "epx-guardrails-route-"));
    process.env.EASYPROXY_HOME = home;
    try {
      const cfg = getDefaultConfig();
      saveConfig(cfg);

      applyOutboundPayloadHygiene(
        {
          input: [
            { role: "user", content: `leak ${fakeGhToken()}` },
          ],
        },
        { outboundSecretGuard: { mode: "redact" }, toolOutputCompression: { enabled: true, minChars: 1024 } },
      );
      applyOutboundPayloadHygiene(
        {
          input: [
            { type: "function_call_output", output: "log line\n".repeat(400) },
          ],
        },
        { outboundSecretGuard: { mode: "redact" }, toolOutputCompression: { enabled: true, minChars: 512, headChars: 120, tailChars: 120 } },
      );

      // Mode "off" does not increment scannedRequests.
      applyOutboundPayloadHygiene(
        { input: [{ role: "user", content: "ordinary" }] },
        { outboundSecretGuard: { mode: "off" } },
      );

      const getRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails"),
        new URL("http://127.0.0.1/api/gateway-guardrails"),
        cfg,
      );
      expect(getRes?.status).toBe(200);
      const getBody = await getRes!.json() as {
        outboundSecretGuard: { mode: string };
        toolOutputCompression: { enabled: boolean; minChars: number; stripAnsi: boolean };
        stats: ReturnType<typeof getOutboundHygieneStats>;
      };
      expect(getBody.toolOutputCompression.stripAnsi).toBe(true);
      expect(getBody.stats.scannedRequests).toBe(2);
      expect(getBody.stats.secretDetections).toBe(1);
      expect(getBody.stats.compressedToolOutputs).toBe(1);
      expect(getBody.stats.savedChars).toBeGreaterThan(0);

      const badPut = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ unknownField: true }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails"),
        cfg,
      );
      expect(badPut?.status).toBe(400);

      const putRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outboundSecretGuard: { mode: "block" },
            toolOutputCompression: { enabled: true, minChars: 2048, headChars: 512, tailChars: 512, stripAnsi: true },
          }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails"),
        cfg,
      );
      expect(putRes?.status).toBe(200);
      expect(cfg.outboundSecretGuard?.mode).toBe("block");
      expect(cfg.toolOutputCompression?.stripAnsi).toBe(true);

      const clearRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ outboundSecretGuard: null, toolOutputCompression: null }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails"),
        cfg,
      );
      expect(clearRes?.status).toBe(200);
      expect("outboundSecretGuard" in cfg).toBe(false);
      expect("toolOutputCompression" in cfg).toBe(false);
    } finally {
      resetOutboundHygieneStatsForTests();
      if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = prevHome;
      removeTreeWithRetry(home);
    }
  });

  test("redacts every rule family including Slack and GitHub fine-grained tokens while leaving benign 64KB prose untouched", () => {
    const slackToken = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");
    const fineGhToken = ["github", "pat", "11AAAAAA0123456789abcdef"].join("_");
    const benign = "routine configuration documentation without secret tokens or key headers\n".repeat(950);
    const benignPayload = { input: benign };
    const benignResult = inspectAndApplyOutboundSecretGuard(benignPayload, { mode: "redact" });
    expect(benignResult.blocked).toBe(false);
    expect(benignResult.matches).toBe(0);
    expect(benignResult.redactions).toBe(0);
    expect(benignPayload.input).toBe(benign);

    const payload = {
      input: [
        benign.slice(0, 2048),
        `oa=${fakeOpenAiKey()}`,
        `an=${fakeAnthropicKey()}`,
        `gh=${fineGhToken}`,
        `aw=${fakeAwsKey()}`,
        `go=${fakeGoogleKey()}`,
        `ep=${fakeEpxToken()}`,
        `sl=${slackToken}`,
        `pm=${fakePemKey()}`,
      ].join(" "),
    };
    const result = inspectAndApplyOutboundSecretGuard(payload, { mode: "redact" });
    expect(result.blocked).toBe(false);
    expect(result.matches).toBeGreaterThanOrEqual(8);
    expect(result.redactions).toBeGreaterThanOrEqual(8);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        "openai_key",
        "anthropic_key",
        "github_token",
        "aws_access_key",
        "google_api_key",
        "easyproxy_token",
        "slack_token",
        "pem_private_key",
      ]),
    );
    expect(payload.input).toContain("[REDACTED:slack_token]");
    expect(payload.input).toContain("[REDACTED:github_token]");
    expect(payload.input).not.toContain(slackToken);
    expect(payload.input).not.toContain(fineGhToken);
  });

  test("POST /api/gateway-guardrails/dry-run evaluates redaction, blocking, and compression without mutating config or hygieneStats", async () => {
    const prevHome = process.env.EASYPROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "epx-guardrails-dryrun-"));
    process.env.EASYPROXY_HOME = home;
    resetOutboundHygieneStatsForTests();
    try {
      const cfg = {
        ...getDefaultConfig(),
        outboundSecretGuard: { mode: "off" as const },
        toolOutputCompression: { enabled: false, minChars: 12_000, headChars: 4_000, tailChars: 4_000, stripAnsi: true },
      };
      saveConfig(cfg);
      const beforeStats = { ...getOutboundHygieneStats() };

      const redactSample = `token=${fakeOpenAiKey()} slack=${["xoxb", "123456789012", "abcdefghijklmnop"].join("-")}`;
      const redactRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails/dry-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: redactSample, outboundSecretGuard: { mode: "redact" } }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails/dry-run"),
        cfg,
      );
      expect(redactRes?.status).toBe(200);
      expect(redactRes?.headers.get("cache-control")).toBe("no-store");
      const redactBody = await redactRes!.json() as Record<string, unknown>;
      expect(redactBody).toMatchObject({
        blocked: false,
        limitExceeded: false,
        matches: 2,
        redactions: 2,
        compressedItems: 0,
        originalChars: redactSample.length,
        savedChars: 0,
      });
      expect(redactBody.findings).toEqual(expect.arrayContaining(["openai_key", "slack_token"]));
      expect(String(redactBody.previewText)).toContain("[REDACTED:openai_key]");
      expect(String(redactBody.previewText)).not.toContain(fakeOpenAiKey());
      expect(redactBody.outputChars).toBe(String(redactBody.previewText).length);

      const blockRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails/dry-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `secret=${fakeAwsKey()}`,
            outboundSecretGuard: { mode: "block" },
            toolOutputCompression: { enabled: true, minChars: 512, headChars: 64, tailChars: 64 },
          }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails/dry-run"),
        cfg,
      );
      expect(blockRes?.status).toBe(200);
      const blockBody = await blockRes!.json() as Record<string, unknown>;
      expect(blockBody).toEqual({
        blocked: true,
        limitExceeded: false,
        matches: 1,
        redactions: 0,
        findings: ["aws_access_key"],
        compressedItems: 0,
        originalChars: `secret=${fakeAwsKey()}`.length,
        outputChars: 0,
        savedChars: 0,
        previewText: "",
      });
      expect(JSON.stringify(blockBody)).not.toContain(fakeAwsKey());

      const ansiLines = Array.from({ length: 120 }, (_, i) => `\x1b[31mline-${i} ${"x".repeat(20)}\x1b[0m`).join("\n");
      const compRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails/dry-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: ansiLines,
            outboundSecretGuard: { mode: "off" },
            toolOutputCompression: { enabled: true, minChars: 512, headChars: 80, tailChars: 80, stripAnsi: true },
          }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails/dry-run"),
        cfg,
      );
      expect(compRes?.status).toBe(200);
      const compBody = await compRes!.json() as Record<string, unknown>;
      expect(compBody.blocked).toBe(false);
      expect(compBody.compressedItems).toBe(1);
      expect(compBody.originalChars).toBe(ansiLines.length);
      expect(Number(compBody.savedChars)).toBeGreaterThan(0);
      expect(Number(compBody.outputChars)).toBeLessThan(ansiLines.length);
      expect(String(compBody.previewText)).not.toContain("\x1b[");

      // Fail-closed 400 and 413 checks
      for (const badBody of [
        null,
        { text: 123 },
        { text: "ok", extra: true },
        { text: "ok", outboundSecretGuard: null },
        { text: "ok", outboundSecretGuard: { mode: "invalid" } },
        { text: "ok", toolOutputCompression: null },
        { text: "ok", toolOutputCompression: { minChars: 10 } },
      ]) {
        const badRes = await handleManagementAPI(
          new ManagementRequest("http://127.0.0.1/api/gateway-guardrails/dry-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(badBody),
          }),
          new URL("http://127.0.0.1/api/gateway-guardrails/dry-run"),
          cfg,
        );
        expect(badRes?.status).toBe(400);
      }

      const tooLargeRes = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/gateway-guardrails/dry-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "a".repeat(65_537) }),
        }),
        new URL("http://127.0.0.1/api/gateway-guardrails/dry-run"),
        cfg,
      );
      expect(tooLargeRes?.status).toBe(413);

      // Dry-run leaves live config and hygieneStats completely untouched.
      expect(cfg.outboundSecretGuard).toEqual({ mode: "off" });
      expect(cfg.toolOutputCompression?.enabled).toBe(false);
      expect(getOutboundHygieneStats()).toEqual(beforeStats);
    } finally {
      resetOutboundHygieneStatsForTests();
      if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = prevHome;
      removeTreeWithRetry(home);
    }
  });
});
