import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as proxyEnv from "../../src/lib/proxy-env";
import * as oauthStore from "../../src/oauth/store";
import { saveConfig } from "../../src/config";
import { loadAdminTokenFromFile } from "../../src/lib/admin-secrets";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  antigravityCliUserAgent,
  antigravityHostPlatform,
  antigravityUserAgent,
} from "../../src/adapters/client-fingerprint";
import {
  antigravityUserAgentForWireModel,
  antigravityDiscoveryUserAgent,
} from "../../src/adapters/google-antigravity-wire";
import {
  probeAntigravityUsageQuota,
  fetchAntigravityQuotaSummaryOnce,
  fetchAntigravityUsageQuota,
  setAntigravityAccountQuotaTransportForTests,
} from "../../src/providers/quota/antigravity";
import { verifyAntigravityImportProject } from "../../src/oauth/account-import/google-antigravity-adapter";
import { refreshAntigravityToken } from "../../src/oauth/google-antigravity";
import { handleGeminiNative } from "../../src/server/gemini-native";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { runGeminiWebSearch } from "../../src/web-search/gemini-executor";
import { warmCodexAccount } from "../../src/codex/warmup";
import { fetchCodexUsage, resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import {
  CODEX_WINDOW_ID_HEADER,
  deriveCodexAccountWindowId,
  isolateCodexPoolAccountHeaders,
  isolateCodexPoolClientMetadata,
} from "../../src/codex/forward-transport-headers";
import { setCodexAccountProxy, saveCodexAccountCredential, readCodexAccountRecord } from "../../src/codex/account-store";
import { consumeResetCredits, createResetCreditWhamClient, inspectResetCredits } from "../../src/codex/auth-api/reset-credit-service";
import { fetchCodexLoginUsageProfile, verifyCodexAccountWarmup } from "../../src/codex/auth-api/login-flow";
import { bindOAuthSnapshotToProvider, getProviderHostPlatform } from "../../src/lib/provider-egress";
import { startServer } from "../../src/server";
import type { EpxConfig, EpxProviderConfig } from "../../src/types";

let previousHome: string | undefined;
let testHome: string;
let outboundSpy: ReturnType<typeof spyOn<typeof proxyEnv, "configuredOutboundFetch">> | undefined;
let server: ReturnType<typeof startServer> | undefined;

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "epx-antiban-"));
  process.env.EASYPROXY_HOME = testHome;
  resetQuotaQueryBackoffForTests();
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  outboundSpy?.mockRestore();
  outboundSpy = undefined;
  setAntigravityAccountQuotaTransportForTests(null);
  resetQuotaQueryBackoffForTests();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testHome);
  removeTreeWithRetry(testHome);
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
});

describe("P0-1 Anti-Ban Egress & Identity Unification", () => {
  test("Antigravity ide and cli UAs always fix to the same single host OS/arch", () => {
    const [hostOs, hostArch] = antigravityHostPlatform().split("/");
    expect(antigravityUserAgent()).toContain(`os_type=${hostOs}; arch=${hostArch};`);
    expect(antigravityCliUserAgent()).toContain(`os_type=${hostOs}; arch=${hostArch};`);
    expect(antigravityUserAgent()).toContain("antigravity/ide/");
    expect(antigravityCliUserAgent()).toContain("antigravity/cli/");

    const ideWin = antigravityUserAgentForWireModel("claude-opus-5-5-high", "windows/amd64");
    const cliWin = antigravityUserAgentForWireModel("gemini-4-argon-high", "windows/amd64");
    expect(ideWin).toContain("antigravity/ide/");
    expect(cliWin).toContain("antigravity/cli/");
    expect(ideWin).toContain("os_type=windows; arch=amd64;");
    expect(cliWin).toContain("os_type=windows; arch=amd64;");
    expect(antigravityDiscoveryUserAgent("windows/amd64")).toBe(cliWin);
  });

  test("quota/antigravity passes config, accountProxy, and hostPlatform into outbound calls and never retries antigravity/1.0", async () => {
    const seen: Array<{ userAgent: string | null; proxy: unknown }> = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({
        hostname: "daily-cloudcode-pa.googleapis.com",
        addresses: [{ address: "142.250.0.1", family: 4 }],
        privateNetwork: false,
      }),
    });
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (_input, init) => {
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      seen.push({
        userAgent: new Headers(reqInit?.headers).get("user-agent"),
        proxy: reqInit?.proxy,
      });
      return new Response(null, { status: 403 });
    });
    const config: EpxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      authMode: "oauth",
      proxy: "http://127.0.0.1:18080",
    };
    const res = await probeAntigravityUsageQuota("tok", "proj", undefined, {
      config,
      accountProxy: "http://127.0.0.1:19090",
      hostPlatform: "linux/amd64",
    });
    expect(res).toEqual({ kind: "unavailable", failure: "access_denied", legacy: { kind: "null" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.proxy).toBe("http://127.0.0.1:19090/");
    expect(seen[0]?.userAgent).toContain("antigravity/cli/");
    expect(seen[0]?.userAgent).toContain("os_type=linux; arch=amd64;");

    const onceSeen: Array<{ userAgent: string | null; proxy: unknown }> = [];
    outboundSpy.mockImplementation(async (_input, init) => {
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      onceSeen.push({ userAgent: new Headers(reqInit?.headers).get("user-agent"), proxy: reqInit?.proxy });
      return Response.json({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] });
    });
    const once = await fetchAntigravityQuotaSummaryOnce("tok", "proj", undefined, () => true, {
      config,
      hostPlatform: "darwin/arm64",
    });
    expect(once.kind).toBe("response");
    expect(onceSeen[0]?.proxy).toBe("http://127.0.0.1:18080/");
    expect(onceSeen[0]?.userAgent).toContain("os_type=darwin; arch=arm64;");
    outboundSpy.mockRestore();
    outboundSpy = undefined;
  });

  test("google-antigravity OAuth refresh routes through provider egress & per-account proxy", async () => {
    const calls: Array<{ url: string; proxy: unknown; redirect: unknown; ua: string | null }> = [];
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      calls.push({
        url,
        proxy: reqInit?.proxy,
        redirect: reqInit?.redirect,
        ua: new Headers(reqInit?.headers).get("user-agent"),
      });
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "refreshed-acc", expires_in: 3600 });
      }
      return Response.json({ cloudaicompanionProject: "proj-pinned" });
    });

    const creds = await refreshAntigravityToken("refresh-secret", undefined, {
      accountProxy: "http://acct-proxy:3128",
      hostPlatform: "linux/amd64",
    });
    expect(creds.access).toBe("refreshed-acc");
    expect(creds.projectId).toBe("proj-pinned");
    expect(calls.every(c => c.proxy === "http://acct-proxy:3128/" && c.redirect === "manual")).toBe(true);
    const loadCall = calls.find(c => c.url.includes(":loadCodeAssist"));
    expect(loadCall?.ua).toContain("antigravity/ide/");
    expect(loadCall?.ua).toContain("os_type=linux; arch=amd64;");
  });

  test("gemini-native and gemini-executor both route through provider egress and per-account proxy/hostPlatform", async () => {
    await oauthStore.saveCredential("google-antigravity", {
      access: "ag-acc-token",
      refresh: "ag-ref-token",
      expires: Date.now() + 3600_000,
      projectId: "proj-ag",
      email: "ag@example.com",
      accountId: "sub-ag-1",
    });
    const acctId = oauthStore.getAccountSet("google-antigravity")!.activeAccountId;
    expect(await oauthStore.setAccountProxy("google-antigravity", acctId, "http://pin:8888")).toBe(true);

    const observed: Array<{ url: string; proxy: unknown; ua: string | null; redirect: unknown }> = [];
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (input, init) => {
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      observed.push({
        url: String(input),
        proxy: reqInit?.proxy,
        ua: new Headers(reqInit?.headers).get("user-agent"),
        redirect: reqInit?.redirect,
      });
      return Response.json({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } });
    });

    const wsOutcome = await runGeminiWebSearch(
      "test query",
      "google-antigravity",
      { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth", proxy: "http://fallback:1080" },
      { model: "gemini-4-argon", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(wsOutcome.text).toBe("ok");
    expect(observed[0]?.proxy).toBe("http://pin:8888/");
    expect(observed[0]?.redirect).toBe("manual");
    expect(observed[0]?.ua).toContain("antigravity/cli/");

    const lease = tryAdmitTurn(undefined, new AbortController().signal)!;
    const cfg = {
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
        },
      },
    } as EpxConfig;
    try {
      const nativeRes = await handleGeminiNative(
        new Request("http://localhost/v1beta/models/gemini-3.8-flash:generateContent", {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        }),
        cfg,
        "gemini-3.8-flash",
        undefined,
        lease,
      );
      expect(nativeRes.status).toBe(200);
    } finally {
      if (!lease.isTransferred()) lease.release();
    }
    expect(observed[1]?.proxy).toBe("http://pin:8888/");
    expect(observed[1]?.ua).toContain("antigravity/ide/");
    expect(observed[1]?.ua?.match(/os_type=[^;]+; arch=[^;]+/)?.[0])
      .toBe(observed[0]?.ua?.match(/os_type=[^;]+; arch=[^;]+/)?.[0]);
  });

  test("bindOAuthSnapshotToProvider clears stale proxy when rotating to an unpinned account", () => {
    const base: EpxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      authMode: "oauth",
      proxy: "http://provider-default:3128",
    };
    const acctA = bindOAuthSnapshotToProvider(base, {
      accessToken: "tA",
      projectId: "pA",
      proxy: "http://acct-a:3128",
      hostPlatform: "linux/amd64",
    }, { setApiKey: true });
    expect(acctA.proxy).toBe("http://acct-a:3128");
    expect(getProviderHostPlatform(acctA)).toBe("linux/amd64");

    const acctB = bindOAuthSnapshotToProvider(acctA, {
      accessToken: "tB",
      projectId: "pB",
    }, { setApiKey: true });
    expect(acctB.proxy).toBe("http://provider-default:3128");
    expect(getProviderHostPlatform(acctB)).toBeUndefined();
  });

  test("codex warmup sends canonical CLI headers + installation id and routes warmup & quota backoff via egress", async () => {
    const sent: Array<{ url: string; proxy: unknown; redirect: unknown; headers: Record<string, string> }> = [];
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (input, init) => {
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      const hdrs: Record<string, string> = {};
      new Headers(reqInit?.headers).forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
      sent.push({ url: String(input), proxy: reqInit?.proxy, redirect: reqInit?.redirect, headers: hdrs });
      if (String(input).includes("/wham/usage")) return Response.json({ rate_limit: {} });
      return new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await warmCodexAccount({
      accessToken: "codex-tok",
      chatgptAccountId: "acct-codex-1",
      proxy: "socks5://127.0.0.1:9050",
    });
    expect(sent[0]?.proxy).toBe("socks5://127.0.0.1:9050");
    expect(sent[0]?.redirect).toBe("manual");
    expect(sent[0]?.headers.originator).toBe("codex_cli_rs");
    expect(sent[0]?.headers["user-agent"]).toMatch(/^codex_cli_rs\/\d+\.\d+\.\d+/);
    expect(sent[0]?.headers["x-codex-installation-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const usage = await fetchCodexUsage("backoff-egress", {
      headers: { Authorization: "Bearer codex-tok", "ChatGPT-Account-Id": "acct-codex-1" },
    }, undefined, {
      accountProxy: "http://wham-proxy:8080",
    });
    expect(usage?.kind).toBe("owner");
    expect(sent[1]?.proxy).toBe("http://wham-proxy:8080/");
    expect(sent[1]?.redirect).toBe("manual");
  });

  test("isolateCodexPoolAccountHeaders & client_metadata derive distinct per-account x-codex-window-id and stay idempotent", () => {
    const hdrsA = new Headers({
      [CODEX_WINDOW_ID_HEADER]: "caller-window-uuid:2",
      "x-codex-installation-id": "caller-install",
      "x-oai-attestation": "drop-me",
    });
    const hdrsB = new Headers({
      [CODEX_WINDOW_ID_HEADER]: "caller-window-uuid:2",
      "x-codex-installation-id": "caller-install",
    });
    isolateCodexPoolAccountHeaders(hdrsA, "acct-alpha");
    isolateCodexPoolAccountHeaders(hdrsB, "acct-beta");
    const winA = hdrsA.get(CODEX_WINDOW_ID_HEADER)!;
    const winB = hdrsB.get(CODEX_WINDOW_ID_HEADER)!;
    expect(winA).not.toContain("caller-window-uuid");
    expect(winB).not.toContain("caller-window-uuid");
    expect(winA).not.toBe(winB);
    expect(winA).toMatch(/^[0-9a-f-]{36}:2$/);
    expect(hdrsA.has("x-oai-attestation")).toBe(false);

    // Repeat isolation pass must be idempotent.
    isolateCodexPoolAccountHeaders(hdrsA, "acct-alpha");
    expect(hdrsA.get(CODEX_WINDOW_ID_HEADER)).toBe(winA);

    const body = { client_metadata: { [CODEX_WINDOW_ID_HEADER]: "caller-window-uuid:2" } };
    const rewritten = isolateCodexPoolClientMetadata(body, "acct-alpha") as typeof body;
    expect(rewritten.client_metadata[CODEX_WINDOW_ID_HEADER]).toBe(deriveCodexAccountWindowId("acct-alpha", "caller-window-uuid:2"));
    expect(isolateCodexPoolClientMetadata(rewritten, "acct-alpha")).toBe(rewritten);
  });

  test("management routes persist per-account proxy and redact credentials in responses and summaries", async () => {
    await oauthStore.saveCredential("google-antigravity", {
      access: "tok-ag",
      refresh: "ref-ag",
      expires: Date.now() + 3600_000,
      projectId: "proj-1",
      email: "ag2@example.com",
      accountId: "sub-ag-2",
    });
    const oauthId = oauthStore.getAccountSet("google-antigravity")!.activeAccountId;

    const codexAcctId = "acct-pool-1";
    saveCodexAccountCredential(codexAcctId, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "cgpt-1",
    });

    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      clientIntegrations: { codex: false },
      codexAccounts: [
        { id: codexAcctId, email: "codex@example.com", chatgptAccountId: "cgpt-1", isMain: false },
      ],
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
        "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" },
      },
    } as EpxConfig);

    server = startServer(0);
    const adminToken = loadAdminTokenFromFile(testHome);
    expect(adminToken).toBeTruthy();
    const putOAuth = await fetch(new URL("/api/oauth/accounts/proxy", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: "google-antigravity", accountId: oauthId, proxy: "http://proxyuser:supersecret@proxy.example.test:8080" }),
    });
    expect(putOAuth.status).toBe(200);
    const oauthJson = await putOAuth.json() as { ok: boolean; hasProxy: boolean; proxyLabel?: string };
    expect(oauthJson.ok).toBe(true);
    expect(oauthJson.hasProxy).toBe(true);
    expect(oauthJson.proxyLabel).toBe("http://proxy.example.test:8080/");
    expect(JSON.stringify(oauthJson)).not.toContain("supersecret");

    const listOAuth = await fetch(new URL("/api/oauth/accounts?provider=google-antigravity", server.url), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listOAuthJson = await listOAuth.json() as { accounts: Array<{ hasProxy?: boolean; proxyLabel?: string; hostPlatform?: string }> };
    expect(listOAuthJson.accounts[0]?.hasProxy).toBe(true);
    expect(listOAuthJson.accounts[0]?.proxyLabel).toBe("http://proxy.example.test:8080/");
    expect(JSON.stringify(listOAuthJson)).not.toContain("supersecret");

    const badProxy = await fetch(new URL("/api/oauth/accounts/proxy", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: "google-antigravity", accountId: oauthId, proxy: "ftp://bad:21" }),
    });
    expect(badProxy.status).toBe(400);

    const putCodex = await fetch(new URL("/api/codex-auth/accounts/proxy", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ id: codexAcctId, proxy: "socks5://user:passsecret@127.0.0.1:9050" }),
    });
    expect(putCodex.status).toBe(200);
    const codexJson = await putCodex.json() as { ok: boolean; hasProxy: boolean; proxyLabel?: string };
    expect(codexJson.hasProxy).toBe(true);
    expect(JSON.stringify(codexJson)).not.toContain("passsecret");
    expect(readCodexAccountRecord(codexAcctId)?.proxy).toBe("socks5://user:passsecret@127.0.0.1:9050");

    expect(setCodexAccountProxy(codexAcctId, null)).toBe(true);
    expect(readCodexAccountRecord(codexAcctId)?.proxy).toBeUndefined();
  });

  test("verifyAntigravityImportProject and fetchAntigravityUsageQuota route through configured google-antigravity egress", async () => {
    saveConfig({
      port: 0,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          proxy: "http://127.0.0.1:8899",
          models: ["gemini-3.5-pro"],
        },
      },
    });
    const seenProxies: Array<unknown> = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({
        hostname: "daily-cloudcode-pa.googleapis.com",
        addresses: [{ address: "142.250.0.1", family: 4 }],
        privateNetwork: false,
      }),
    });
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (_input, init) => {
      seenProxies.push((init as proxyEnv.ProxyCapableRequestInit | undefined)?.proxy);
      return Response.json({
        groups: [
          { displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.75, resetTime: "2026-12-01T00:00:00Z" }] },
        ],
      });
    });

    const verified = await verifyAntigravityImportProject("ya29.test", "proj-import");
    const quota = await fetchAntigravityUsageQuota("ya29.test", "proj-quota");
    expect(verified).toBe(true);
    expect(quota?.customWindows?.length).toBeGreaterThan(0);
    expect(seenProxies).toEqual(["http://127.0.0.1:8899/", "http://127.0.0.1:8899/"]);
  });

  test("codex reset-credit-service routes inspect and consume through providerEgressFetch and account proxy pin", async () => {
    const pinnedAcctId = "acct-reset-pinned";
    const inheritedAcctId = "acct-reset-inherited";
    saveCodexAccountCredential(pinnedAcctId, {
      accessToken: "at-pinned",
      refreshToken: "rt-pinned",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-pinned",
    });
    saveCodexAccountCredential(inheritedAcctId, {
      accessToken: "at-inherited",
      refreshToken: "rt-inherited",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-inherited",
    });
    expect(setCodexAccountProxy(pinnedAcctId, "socks5://127.0.0.1:9150")).toBe(true);

    const cfg: EpxConfig = {
      port: 0,
      defaultProvider: "openai",
      codexAccounts: [
        { id: pinnedAcctId, email: "pinned@example.test", chatgptAccountId: "cgpt-pinned", isMain: false },
        { id: inheritedAcctId, email: "inherited@example.test", chatgptAccountId: "cgpt-inherited", isMain: false },
      ],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
          proxy: "http://127.0.0.1:18181",
        },
      },
    };
    saveConfig(cfg);

    const calls: Array<{ url: string; proxy: unknown; redirect: unknown }> = [];
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const reqInit = init as proxyEnv.ProxyCapableRequestInit | undefined;
      calls.push({ url, proxy: reqInit?.proxy, redirect: reqInit?.redirect });
      if (url.endsWith("/consume")) {
        return Response.json({ code: "no_credit" });
      }
      if (url.endsWith("/wham/usage")) {
        return Response.json({ rate_limit: {} });
      }
      return Response.json({
        credits: [{ granted_at: "2026-11-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z" }],
        available_count: 1,
      });
    });

    const whamClient = createResetCreditWhamClient(cfg, pinnedAcctId);
    const inspected = await whamClient.inspect();
    expect(inspected.credits).toHaveLength(1);
    const consumed = await whamClient.consume("00000000-0000-4000-8000-000000000123");
    expect(consumed).toEqual({ code: "no_credit" });

    const routeInspected = await inspectResetCredits(cfg, inheritedAcctId, new AbortController().signal);
    expect(routeInspected.status).toBe(200);
    const routeConsumed = await consumeResetCredits(cfg, pinnedAcctId, undefined);
    expect(routeConsumed.status).toBe(200);

    expect(calls).toEqual([
      {
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        proxy: "socks5://127.0.0.1:9150",
        redirect: "manual",
      },
      {
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        proxy: "socks5://127.0.0.1:9150",
        redirect: "manual",
      },
      {
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        proxy: "http://127.0.0.1:18181/",
        redirect: "manual",
      },
      {
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        proxy: "socks5://127.0.0.1:9150",
        redirect: "manual",
      },
    ]);
  });

  test("codex login-flow wham/usage profile fetch and warmup verification route through providerEgressFetch and account proxy pin", async () => {
    const pinnedId = "acct-login-pinned";
    saveCodexAccountCredential(pinnedId, {
      accessToken: "at-login",
      refreshToken: "rt-login",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-login",
    });
    expect(setCodexAccountProxy(pinnedId, "socks5://127.0.0.1:9155")).toBe(true);

    const cfg: EpxConfig = {
      port: 0,
      defaultProvider: "openai",
      codexAccounts: [
        { id: pinnedId, email: "login@example.test", chatgptAccountId: "cgpt-login", isMain: false },
      ],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
          proxy: "http://127.0.0.1:18182",
        },
      },
    };
    saveConfig(cfg);

    const seen: Array<{ url: string; proxy: unknown }> = [];
    outboundSpy = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push({ url, proxy: (init as proxyEnv.ProxyCapableRequestInit | undefined)?.proxy });
      if (url.endsWith("/wham/usage")) {
        return Response.json({ email: "login@example.test", plan_type: "plus" });
      }
      return new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const newLoginProfile = await fetchCodexLoginUsageProfile(cfg, "acct-brand-new", false, "at-new", "cgpt-new");
    expect(newLoginProfile?.email).toBe("login@example.test");
    const reauthProfile = await fetchCodexLoginUsageProfile(cfg, pinnedId, true, "at-login", "cgpt-login");
    expect(reauthProfile?.plan_type).toBe("plus");
    const warmup = await verifyCodexAccountWarmup(pinnedId, "at-login", "cgpt-login");
    expect(warmup.ok).toBe(true);

    expect(seen).toEqual([
      { url: "https://chatgpt.com/backend-api/wham/usage", proxy: "http://127.0.0.1:18182/" },
      { url: "https://chatgpt.com/backend-api/wham/usage", proxy: "socks5://127.0.0.1:9155" },
      { url: "https://chatgpt.com/backend-api/codex/responses", proxy: "socks5://127.0.0.1:9155" },
    ]);
  });

  test("PUT /api/oauth/accounts/proxy and /api/codex-auth/accounts/proxy classify proxy='direct' as hasProxy:false and clear OAuth quota cache", async () => {
    const {
      getCachedProviderAccountQuota,
      setCachedProviderAccountQuotaForTests,
    } = await import("../../src/providers/quota");
    await oauthStore.saveCredential("google-antigravity", {
      access: "tok-ag-direct",
      refresh: "ref-ag-direct",
      expires: Date.now() + 3600_000,
      projectId: "proj-direct",
      email: "ag-direct@example.com",
      accountId: "sub-ag-direct",
    });
    const oauthId = oauthStore.getAccountSet("google-antigravity")!.activeAccountId;
    const codexAcctId = "acct-direct-1";
    saveCodexAccountCredential(codexAcctId, {
      accessToken: "at-d1",
      refreshToken: "rt-d1",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "cgpt-d1",
    });

    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      clientIntegrations: { codex: false },
      codexAccounts: [
        { id: codexAcctId, email: "codex-d@example.com", chatgptAccountId: "cgpt-d1", isMain: false },
      ],
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
        "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" },
      },
    } as EpxConfig);

    setCachedProviderAccountQuotaForTests("google-antigravity", oauthId, {
      updatedAt: Date.now(),
      fiveHourPercent: 80,
    });
    expect(getCachedProviderAccountQuota("google-antigravity", oauthId)).toBeDefined();

    server = startServer(0);
    const adminToken = loadAdminTokenFromFile(testHome);
    const putOAuth = await fetch(new URL("/api/oauth/accounts/proxy", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: "google-antigravity", accountId: oauthId, proxy: "direct" }),
    });
    expect(putOAuth.status).toBe(200);
    const oauthJson = await putOAuth.json() as { ok: boolean; hasProxy: boolean; proxyLabel?: string };
    expect(oauthJson).toMatchObject({ ok: true, hasProxy: false });
    expect(oauthJson.proxyLabel).toBeUndefined();
    expect(getCachedProviderAccountQuota("google-antigravity", oauthId)).toBeNull();

    const listOAuth = await fetch(new URL("/api/oauth/accounts?provider=google-antigravity", server.url), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listOAuthJson = await listOAuth.json() as { accounts: Array<{ hasProxy?: boolean; proxyLabel?: string }> };
    expect(listOAuthJson.accounts[0]?.hasProxy).toBeUndefined();
    expect(listOAuthJson.accounts[0]?.proxyLabel).toBeUndefined();

    const putCodex = await fetch(new URL("/api/codex-auth/accounts/proxy", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ id: codexAcctId, proxy: "direct" }),
    });
    expect(putCodex.status).toBe(200);
    const codexJson = await putCodex.json() as { ok: boolean; hasProxy: boolean; proxyLabel?: string };
    expect(codexJson).toMatchObject({ ok: true, hasProxy: false });
    expect(codexJson.proxyLabel).toBeUndefined();
  });
});
