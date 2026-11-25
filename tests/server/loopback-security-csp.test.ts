import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import {
  isAllowedRequestOrigin,
  resolveApiAuth,
  resolveResponsesApiAuth,
} from "../../src/server/auth-cors";
import { serveGuiFile } from "../../src/server/gui-static";
import { handleManagementAPI } from "../../src/server/management-api";
import { clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import type { GatewayClientContext } from "../../src/integrations/gateway-clients";
import type { EpxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const LOOPBACK_KEY = "epx_data_" + "1".repeat(40);
const OTHER_KEY = "epx_data_" + "2".repeat(40);
const RPM_KEY = "epx_data_" + "3".repeat(40);
const LOOPBACK_ONLY_KEY = "epx_data_" + "4".repeat(40);
const EXPIRED_KEY = "epx_data_" + "5".repeat(40);

const originalFetch = globalThis.fetch;
let home = "";
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousAdminToken: string | undefined;
let releaseSpend: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousAdminToken = process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "epx-loopback-sec-csp-"));
  process.env.EASYPROXY_HOME = home;
  process.env.CODEX_HOME = home;
  process.env.EASYPROXY_ADMIN_AUTH_TOKEN = "loopback-sec-admin-token";
  releaseSpend = acquireOwnedSpendHome();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpend?.();
  releaseSpend = undefined;
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousAdminToken === undefined) delete process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
  else process.env.EASYPROXY_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (home) removeTreeWithRetry(home);
  home = "";
});

describe("Stage 2 loopback data-plane security, Direct 401 fix, origin gate, and CSP", () => {
  test("loopback enforces key budgets (RPM/TPM) and model scope whenever x-easyproxy-api-key or Bearer epx_data_ is sent", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
      }),
    });
    const config: EpxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: `${upstream.url}v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "upstream-alpha",
          models: ["gpt-alpha"],
        },
        beta: {
          adapter: "openai-chat",
          baseUrl: `${upstream.url}v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "upstream-beta",
          models: ["gpt-beta"],
        },
      },
      apiKeys: [
        {
          id: "scoped-loopback",
          name: "scoped",
          key: LOOPBACK_KEY,
          createdAt: "2026-10-01T00:00:00.000Z",
          allowedProviders: ["alpha"],
          allowedModels: ["alpha/gpt-alpha"],
        },
        {
          id: "rpm-limited",
          name: "rpm",
          key: RPM_KEY,
          createdAt: "2026-10-01T00:00:00.000Z",
          rpmLimit: 1,
        },
        {
          id: "tpm-limited",
          name: "tpm",
          key: OTHER_KEY,
          createdAt: "2026-10-01T00:00:00.000Z",
          tpmLimit: 100,
        },
        {
          id: "expired-key",
          name: "expired",
          key: EXPIRED_KEY,
          createdAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const chat = async (headers: Record<string, string>, model: string) =>
        fetch(new URL("/v1/chat/completions", server.url), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
        });

      // Model scope denied on loopback for both x-easyproxy-api-key and Bearer epx_data_...
      expect((await chat({ "x-easyproxy-api-key": LOOPBACK_KEY }, "beta/gpt-beta")).status).toBe(403);
      expect((await chat({ authorization: `Bearer ${LOOPBACK_KEY}` }, "beta/gpt-beta")).status).toBe(403);
      expect((await chat({ authorization: `Bearer ${LOOPBACK_KEY}` }, "alpha/gpt-alpha")).status).toBe(200);

      // RPM budget enforced on loopback
      expect((await chat({ "x-easyproxy-api-key": RPM_KEY }, "alpha/gpt-alpha")).status).toBe(200);
      expect((await chat({ "x-easyproxy-api-key": RPM_KEY }, "alpha/gpt-alpha")).status).toBe(429);

      // TPM budget enforced on loopback via Bearer epx_data_...
      expect((await chat({ authorization: `Bearer ${OTHER_KEY}` }, "alpha/gpt-alpha")).status).toBe(200);
      expect((await chat({ authorization: `Bearer ${OTHER_KEY}` }, "alpha/gpt-alpha")).status).toBe(429);

      // Expired, revoked, typo, or unmatched proxy credentials must fail closed (401) even on
      // loopback so revoking/deleting a key never escalates privileges back to unrestricted loopback;
      // only non-proxy external tokens (e.g. Codex Direct ChatGPT JWT) and unkeyed loopback pass.
      const revokedKey = "epx_data_" + "f".repeat(40);
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": EXPIRED_KEY },
      }), config)).toBeNull();
      expect((await chat({ "x-easyproxy-api-key": EXPIRED_KEY }, "alpha/gpt-alpha")).status).toBe(401);
      expect((await chat({ authorization: `Bearer ${EXPIRED_KEY}` }, "alpha/gpt-alpha")).status).toBe(401);
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { authorization: `Bearer ${EXPIRED_KEY}` },
      }), { ...config, hostname: "0.0.0.0" })).toBeNull();

      // Revoked/unmatched x-easyproxy-api-key (both epx_... shape and arbitrary custom key) -> 401
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": revokedKey },
      }), config)).toBeNull();
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": "revoked-custom-key" },
      }), config)).toBeNull();
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { "x-easyproxy-api-key": revokedKey },
      }), config)).toBeNull();
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { "x-easyproxy-api-key": "revoked-custom-key" },
      }), config)).toBeNull();
      expect((await chat({ "x-easyproxy-api-key": revokedKey }, "alpha/gpt-alpha")).status).toBe(401);
      expect((await chat({ "x-easyproxy-api-key": "revoked-custom-key" }, "alpha/gpt-alpha")).status).toBe(401);

      // Revoked/unmatched proxy-shaped Bearer or x-api-key -> 401 (never escalate to loopback)
      for (const badShape of [
        revokedKey,
        "epx_admin_" + "a".repeat(43),
        "epx_session_" + "b".repeat(32),
        "epx_pair_" + "p".repeat(43),
        "epx_catalog_" + "k".repeat(43),
        "epx_hub_relay_" + "h".repeat(43),
        "epxrw_" + "r".repeat(43),
        "epx_" + "c".repeat(40),
      ]) {
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { authorization: `Bearer ${badShape}` },
        }), config)).toBeNull();
        expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
          headers: { authorization: `Bearer ${badShape}` },
        }), config)).toBeNull();
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { "x-api-key": badShape },
        }), config)).toBeNull();
      }
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": "epx_data_dsh" },
      }), config)).toBeNull();
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-api-key": "epx_data_dsh" },
      }), config)).toBeNull();
      expect((await chat({ authorization: `Bearer ${revokedKey}` }, "alpha/gpt-alpha")).status).toBe(401);
      expect((await fetch(new URL("/v1/models", server.url), { headers: { "x-api-key": revokedKey } })).status).toBe(401);

      // Non-proxy external tokens (ChatGPT JWT / external API keys / DSH loopback placeholder) keep loopback admission
      const sampleExternalJwt = ["eyJhbGciOiJSUzI1NiJ9", "payload", "sig"].join(".");
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { authorization: `Bearer ${sampleExternalJwt}` },
      }), config)).toEqual({ kind: "loopback", source: "loopback" });
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { authorization: "Bearer epx_data_dsh" },
      }), config)).toEqual({ kind: "loopback", source: "loopback" });
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/messages", {
        headers: { "x-api-key": "sk-test-001external" },
      }), config)).toEqual({ kind: "loopback", source: "loopback" });
      expect((await chat({ authorization: "Bearer sk-test-002upstream" }, "alpha/gpt-alpha")).status).toBe(200);

      // Custom non-epx_ virtual keys in Bearer/x-api-key on loopback also enforce scope and expiry.
      const customScopedCfg: EpxConfig = {
        ...config,
        apiKeys: [
          ...(config.apiKeys ?? []),
          { id: "custom-scoped", name: "custom-scoped", key: "custom-scoped-secret", createdAt: "2026-10-01T00:00:00.000Z", allowedModels: ["alpha/gpt-alpha"] },
          { id: "custom-expired", name: "custom-expired", key: "custom-expired-secret", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z" },
        ],
      };
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/chat/completions", {
        headers: { authorization: "Bearer custom-scoped-secret" },
      }), customScopedCfg)).toMatchObject({ kind: "configured", keyId: "custom-scoped", source: "bearer" });
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/messages", {
        headers: { "x-api-key": "custom-scoped-secret" },
      }), customScopedCfg)).toMatchObject({ kind: "configured", keyId: "custom-scoped", source: "x-api-key" });
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/chat/completions", {
        headers: { authorization: "Bearer custom-expired-secret" },
      }), customScopedCfg)).toBeNull();
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { authorization: "Bearer custom-expired-secret" },
      }), customScopedCfg)).toBeNull();

      // Revoking the last virtual key leaves config.apiKeys empty, yet unmatched epx_* tokens
      // AND any non-empty unmatched x-easyproxy-api-key MUST still fail closed (401).
      const emptyKeysConfig = { ...config, apiKeys: [] };
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": revokedKey },
      }), emptyKeysConfig)).toBeNull();
      expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
        headers: { "x-easyproxy-api-key": "revoked-custom-key" },
      }), emptyKeysConfig)).toBeNull();
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { "x-easyproxy-api-key": "revoked-custom-key" },
      }), emptyKeysConfig)).toBeNull();
      expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
        headers: { authorization: `Bearer ${revokedKey}` },
      }), emptyKeysConfig)).toBeNull();

      // Configured environment token preserves loopback identity on loopback binds (for Reserve/WS)
      // while resolving as environment admission on non-loopback binds.
      const prevEnvApiToken = process.env.EASYPROXY_API_AUTH_TOKEN;
      process.env.EASYPROXY_API_AUTH_TOKEN = "epx_data_" + "e".repeat(40);
      try {
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { "x-easyproxy-api-key": process.env.EASYPROXY_API_AUTH_TOKEN },
        }), config)).toEqual({ kind: "loopback", source: "loopback" });
        expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
          headers: { authorization: `Bearer ${process.env.EASYPROXY_API_AUTH_TOKEN}` },
        }), config)).toEqual({ kind: "loopback", source: "loopback", bearerCredential: true });
        expect(resolveResponsesApiAuth(new Request("http://127.0.0.1:10100/v1/responses", {
          headers: { authorization: `Bearer ${process.env.EASYPROXY_API_AUTH_TOKEN}` },
        }), { ...config, hostname: "0.0.0.0" })).toMatchObject({ kind: "environment", source: "bearer" });
      } finally {
        if (prevEnvApiToken === undefined) delete process.env.EASYPROXY_API_AUTH_TOKEN;
        else process.env.EASYPROXY_API_AUTH_TOKEN = prevEnvApiToken;
      }

      // Live local management admin token via x-easyproxy-api-key keeps loopback admission,
      // whereas stale admin-api-token files (when env admin is active) and arbitrary epx_admin_* fail closed.
      const prevEnvAdminToken = process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
      const staleFileAdmin = "epx_admin_" + "s".repeat(43);
      writeFileSync(join(home, "admin-api-token"), staleFileAdmin + "\n");
      process.env.EASYPROXY_ADMIN_AUTH_TOKEN = "epx_admin_" + "d".repeat(43);
      try {
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { "x-easyproxy-api-key": process.env.EASYPROXY_ADMIN_AUTH_TOKEN },
        }), config)).toEqual({ kind: "loopback", source: "loopback" });
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { "x-easyproxy-api-key": staleFileAdmin },
        }), config)).toBeNull();
        expect(resolveApiAuth(new Request("http://127.0.0.1:10100/v1/models", {
          headers: { "x-easyproxy-api-key": "epx_admin_" + "z".repeat(43) },
        }), config)).toBeNull();
      } finally {
        if (prevEnvAdminToken === undefined) delete process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
        else process.env.EASYPROXY_ADMIN_AUTH_TOKEN = prevEnvAdminToken;
      }

      const validXApiKeyModels = await (await fetch(new URL("/v1/models", server.url), {
        headers: { "x-api-key": LOOPBACK_KEY },
      })).json() as { data: Array<{ id: string }> };
      expect(validXApiKeyModels.data.some(m => m.id.includes("gpt-beta"))).toBe(false);

      // Keyless loopback still succeeds
      expect((await chat({}, "beta/gpt-beta")).status).toBe(200);
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("local Codex Direct over loopback succeeds with Bearer epx_data_... (resolves core-auth.ts 401)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const payload = Buffer.from(JSON.stringify({ exp, chatgpt_account_id: "acct-loopback-direct" })).toString("base64url");
    const storedCredential = `header.${payload}.signature`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { access_token: storedCredential, account_id: "acct-loopback-direct" },
    }));
    const config: EpxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: CODEX_FORWARD_BASE_URL,
          authMode: "forward",
          codexAccountMode: "direct",
          upstreamWebsocket: false,
        },
      },
      apiKeys: [
        { id: "direct-loopback-key", name: "codex-direct", key: LOOPBACK_KEY, createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    };
    saveConfig(config);

    const seenOutbound: Headers[] = [];
    const server = startServer(0);
    const localFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(CODEX_FORWARD_BASE_URL)) {
        seenOutbound.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
        return Response.json({ id: "resp_direct_loopback", object: "response", status: "completed", output: [] });
      }
      return localFetch(input, init);
    }) as typeof fetch;

    try {
      const response = await localFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${LOOPBACK_KEY}`,
        },
        body: JSON.stringify({ model: "openai/gpt-5.3-codex", input: "hi", stream: false }),
      });
      expect(response.status).toBe(200);
      expect(seenOutbound).toHaveLength(1);
      expect(seenOutbound[0]!.get("authorization")).toBe(`Bearer ${storedCredential}`);
      expect(seenOutbound[0]!.get("authorization")).not.toContain(LOOPBACK_KEY);
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
    }
  });

  test("local Codex Direct over loopback succeeds with Bearer environment token across POST /v1/responses, POST /v1/responses/compact, and WS /v1/responses", async () => {
    const previousEnvToken = process.env.EASYPROXY_API_AUTH_TOKEN;
    const envToken = "epx_data_" + "f".repeat(40);
    process.env.EASYPROXY_API_AUTH_TOKEN = envToken;
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const payload = Buffer.from(JSON.stringify({ exp, chatgpt_account_id: "acct-loopback-direct-env" })).toString("base64url");
    const storedCredential = `header.${payload}.signature`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { access_token: storedCredential, account_id: "acct-loopback-direct-env" },
    }));
    const config: EpxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      websockets: true,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: CODEX_FORWARD_BASE_URL,
          authMode: "forward",
          codexAccountMode: "direct",
          upstreamWebsocket: false,
        },
      },
    };
    saveConfig(config);

    const seenOutbound: Array<{ url: string; headers: Headers }> = [];
    const server = startServer(0);
    const localFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(CODEX_FORWARD_BASE_URL)) {
        seenOutbound.push({
          url,
          headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        });
        if (url.includes("/compact")) {
          return Response.json({ object: "response.compaction", output: [] });
        }
        return Response.json({ id: "resp_direct_env_bearer", object: "response", status: "completed", output: [] });
      }
      return localFetch(input, init);
    }) as typeof fetch;

    try {
      const httpRes = await localFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${envToken}`,
        },
        body: JSON.stringify({ model: "openai/gpt-5.3-codex", input: "hi", stream: false }),
      });
      expect(httpRes.status).toBe(200);

      const compactRes = await localFetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${envToken}`,
        },
        body: JSON.stringify({ model: "openai/gpt-5.3-codex", input: [{ role: "user", content: "hi" }] }),
      });
      expect(compactRes.status).toBe(200);

      const wsUrl = new URL("/v1/responses", server.url);
      wsUrl.protocol = "ws:";
      const wsCompleted = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = new WebSocket(wsUrl.toString(), {
          headers: { authorization: `Bearer ${envToken}` },
        } as unknown as string[]);
        const timer = setTimeout(() => {
          try { socket.close(); } catch { /* ignore */ }
          reject(new Error("Timed out waiting for WS response.completed"));
        }, 5_000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({
            type: "response.create",
            model: "openai/gpt-5.3-codex",
            input: "hi over ws",
          }));
        });
        socket.addEventListener("message", event => {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (frame.type === "error") {
            clearTimeout(timer);
            socket.close();
            reject(new Error(`Unexpected WS error frame: ${JSON.stringify(frame)}`));
          } else if (frame.type === "response.completed") {
            clearTimeout(timer);
            socket.close();
            resolve(frame);
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("WebSocket error"));
        });
      });
      expect(wsCompleted.type).toBe("response.completed");

      expect(seenOutbound).toHaveLength(3);
      for (const call of seenOutbound) {
        expect(call.headers.get("authorization")).toBe(`Bearer ${storedCredential}`);
        expect(call.headers.get("authorization")).not.toContain(envToken);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousEnvToken === undefined) delete process.env.EASYPROXY_API_AUTH_TOKEN;
      else process.env.EASYPROXY_API_AUTH_TOKEN = previousEnvToken;
      await server.stop(true);
    }
  });

  test("loopbackOnly keys work on loopback listeners and are refused on non-loopback listeners", () => {
    const loopbackCfg: EpxConfig = {
      hostname: "127.0.0.1",
      apiKeys: [{ id: "lb-only", name: "agy", key: LOOPBACK_ONLY_KEY, createdAt: "2026-10-01T00:00:00.000Z", loopbackOnly: true }],
    };
    const publicCfg: EpxConfig = {
      ...loopbackCfg,
      hostname: "0.0.0.0",
    };
    const reqDedicated = () => new Request("http://127.0.0.1:10100/v1/models", { headers: { "x-easyproxy-api-key": LOOPBACK_ONLY_KEY } });
    const reqBearer = () => new Request("http://127.0.0.1:10100/v1/responses", { headers: { authorization: `Bearer ${LOOPBACK_ONLY_KEY}` } });

    expect(resolveApiAuth(reqDedicated(), loopbackCfg)).toMatchObject({ kind: "configured", keyId: "lb-only", source: "dedicated" });
    expect(resolveResponsesApiAuth(reqBearer(), loopbackCfg)).toMatchObject({ kind: "configured", keyId: "lb-only", source: "bearer" });
    expect(resolveApiAuth(reqDedicated(), publicCfg)).toBeNull();
    expect(resolveResponsesApiAuth(reqBearer(), publicCfg)).toBeNull();
  });

  test("isAllowedRequestOrigin blocks cross-port localhost origins unless allowlisted", async () => {
    const loopbackCfg: EpxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "alpha", providers: { alpha: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["m"] } } };
    const remoteCfg: EpxConfig = {
      ...loopbackCfg,
      hostname: "0.0.0.0",
      apiKeys: [{ id: "k", name: "k", key: LOOPBACK_KEY, createdAt: "2026-10-01T00:00:00.000Z" }],
    };
    expect(isAllowedRequestOrigin(new Request("http://localhost:10100/v1/models", { headers: { Host: "localhost:10100", Origin: "http://localhost:3000" } }), loopbackCfg)).toBe(false);
    expect(isAllowedRequestOrigin(new Request("http://127.0.0.1:10100/v1/models", { headers: { Host: "127.0.0.1:10100", Origin: "http://127.0.0.1:5173" } }), loopbackCfg)).toBe(false);
    expect(isAllowedRequestOrigin(new Request("http://127.0.0.1:10100/v1/models", { headers: { Host: "127.0.0.1:10100", Origin: "http://localhost:3000" } }), remoteCfg)).toBe(false);
    expect(isAllowedRequestOrigin(new Request("http://127.0.0.1:10100/v1/models", { headers: { Host: "127.0.0.1:10100", Origin: "http://127.0.0.1:10100" } }), loopbackCfg)).toBe(true);
    expect(isAllowedRequestOrigin(
      new Request("http://127.0.0.1:10100/v1/models", { headers: { Host: "127.0.0.1:10100", Origin: "http://localhost:3000" } }),
      { ...loopbackCfg, corsAllowOrigins: ["http://localhost:3000"] },
    )).toBe(true);

    saveConfig(loopbackCfg);
    const server = startServer(0);
    try {
      const blocked = await fetch(new URL("/v1/models", server.url), {
        headers: { Origin: "http://localhost:3000" },
      });
      expect(blocked.status).toBe(403);
      const allowed = await fetch(new URL("/v1/models", server.url), {
        headers: { Origin: server.url.origin },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Antigravity one-click connect auto-issues a loopback-only restricted-scope token and revokes it on disconnect", async () => {
    const gatewayRoot = mkdtempSync(join(tmpdir(), "epx-agy-gateway-"));
    mkdirSync(join(gatewayRoot, "home"));
    const gatewayCtx: GatewayClientContext = {
      home: join(gatewayRoot, "home"),
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      stateDir: join(gatewayRoot, "state"),
      lifecycleLockPath: join(gatewayRoot, "runtime", "lifecycle.sqlite"),
    };
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { adapter: "google-antigravity", baseUrl: "https://example.test", models: ["gemini-3"] },
      },
    };
    saveConfig(cfg);

    try {
      const call = async (method: string, path: string, body?: unknown, targetCfg = cfg) => {
        const req = new Request(`http://localhost${path}`, {
          method,
          headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const response = await handleManagementAPI(req, new URL(req.url), targetCfg, {
          gatewayClientContext: () => gatewayCtx,
          liveListenPort: () => 10100,
        });
        return { status: response?.status, json: (await response?.json()) as Record<string, unknown> };
      };

      const connected = await call("POST", "/api/gateway-clients/antigravity/connect", { model: "gemini-3" });
      expect(connected.status).toBe(200);
      expect(connected.json.issuedApiKeyId).toBeString();
      const issuedKey = cfg.apiKeys?.find(k => k.id === connected.json.issuedApiKeyId);
      expect(issuedKey).toBeDefined();
      expect(issuedKey!.loopbackOnly).toBe(true);
      expect(issuedKey!.allowedModels).toEqual(["gemini-3"]);
      expect(issuedKey!.key).toMatch(/^epx_data_[0-9a-f]{40}$/);

      const writtenSettings = JSON.parse(readFileSync(join(gatewayCtx.home, ".antigravity", "settings.json"), "utf8")) as {
        gateway: { apiKey: string; url: string };
      };
      expect(writtenSettings.gateway.apiKey).toBe(issuedKey!.key);

      // Reconnecting without model reuses the managed key and tightens provider scope cleanly without duplicates.
      const reconnected = await call("POST", "/api/gateway-clients/antigravity/connect", {});
      expect(reconnected.status).toBe(200);
      expect(reconnected.json.issuedApiKeyId).toBe(issuedKey!.id);
      expect(cfg.apiKeys).toHaveLength(1);
      expect(cfg.apiKeys![0]!.allowedProviders).toEqual(["google-antigravity"]);

      const disconnected = await call("POST", "/api/gateway-clients/antigravity/disconnect");
      expect(disconnected.status).toBe(200);
      expect(cfg.apiKeys).toHaveLength(0);
    } finally {
      removeTreeWithRetry(gatewayRoot);
    }
  });

  test("gui/index.html has no inline script and gui-static enforces script-src 'self'; connect-src 'self'; object-src 'none'", () => {
    const indexHtml = readFileSync(repoPath("gui", "index.html"), "utf8");
    const bootJs = readFileSync(repoPath("gui", "public", "boot.js"), "utf8");
    expect(indexHtml).toContain('<script src="/boot.js"></script>');
    expect(bootJs).toContain("epx-theme");

    const dist = mkdtempSync(join(tmpdir(), "epx-csp-dist-"));
    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), indexHtml);
      writeFileSync(join(dist, "boot.js"), bootJs);
      const htmlRes = serveGuiFile("/", dist);
      expect(htmlRes).not.toBeNull();
      const csp = htmlRes!.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("object-src 'none'");
      const bootRes = serveGuiFile("/boot.js", dist);
      expect(bootRes).not.toBeNull();
      expect(bootRes!.status).toBe(200);
      expect(existsSync(join(dist, "boot.js"))).toBe(true);
    } finally {
      removeTreeWithRetry(dist);
    }
  });
});
