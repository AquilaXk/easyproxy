import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderShareDeepLink,
  maskDeepLinkApiKey,
  MAX_EPX_DEEP_LINK_BYTES,
  previewProviderDeepLink,
  applyProviderDeepLink,
} from "../../src/providers/deep-link-import";
import { handleProviderImportUrlCommand, handleProviderShareUrlCommand } from "../../src/cli/provider-deep-link";
import { getDefaultConfig, getConfigPath, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let sandboxRoot: string;
let configDir: string;
let prevEasyproxyHome: string | undefined;

function toBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function makeDeepLinkRequest(path: string, method: "GET" | "POST", body?: unknown): Request {
  return new ManagementRequest(`http://127.0.0.1:10100${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  prevEasyproxyHome = process.env.EASYPROXY_HOME;
  sandboxRoot = mkdtempSync(join(tmpdir(), "epx-deeplink-"));
  configDir = join(sandboxRoot, "epx-home");
  mkdirSync(configDir, { recursive: true });
  process.env.EASYPROXY_HOME = configDir;
  const cfg = getDefaultConfig();
  saveConfig(cfg);
});

afterEach(() => {
  if (prevEasyproxyHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = prevEasyproxyHome;
  removeTreeWithRetry(sandboxRoot);
});

describe("epx:// provider import deep links and keyless sharing", () => {
  test("parses query params and base64url payloads, masks apiKey in preview, and builds keyless share URL", async () => {
    const queryUrl = "epx://provider?name=openrouter-custom&adapter=openai-chat&baseUrl=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&apiKey=sk-secret-value-9999&defaultModel=openai%2Fgpt-4o&models=openai%2Fgpt-4o%2Canthropic%2Fclaude-sonnet";
    const preview = await previewProviderDeepLink(queryUrl, { lookupDns: async () => [{ address: "104.21.10.2", family: 4 }] });

    expect(preview.name).toBe("openrouter-custom");
    expect(preview.adapter).toBe("openai-chat");
    expect(preview.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(preview.models).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet"]);
    expect(preview.hasApiKey).toBe(true);
    expect(preview.maskedApiKey).toBeTruthy();
    expect(JSON.stringify(preview)).not.toContain("sk-secret-value-9999");
    expect(preview.canImport).toBe(true);

    const payloadUrl = `epx://import?payload=${toBase64Url({
      name: "anthropic-relay",
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-1234567890",
      defaultModel: "claude-sonnet-4-5",
      apiKeyTransport: "x-api-key",
    })}`;
    const payloadPreview = await previewProviderDeepLink(payloadUrl, { lookupDns: async () => [{ address: "160.79.104.10", family: 4 }] });
    expect(payloadPreview.name).toBe("anthropic-relay");
    expect(payloadPreview.adapter).toBe("anthropic");
    expect(JSON.stringify(payloadPreview)).not.toContain("sk-ant-1234567890");

    const applied = await applyProviderDeepLink(payloadUrl, {
      lookupDns: async () => [{ address: "160.79.104.10", family: 4 }],
    });
    expect(applied.name).toBe("anthropic-relay");
    expect(JSON.stringify(applied)).not.toContain("sk-ant-1234567890");

    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(persisted.providers["anthropic-relay"].adapter).toBe("anthropic");
    expect(persisted.providers["anthropic-relay"].apiKey).toBe("sk-ant-1234567890");

    const shareUrl = buildProviderShareDeepLink("anthropic-relay", {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-1234567890",
      apiKeyPool: [{ id: "k1", key: "sk-ant-pool-key" }],
      headers: { Authorization: "Bearer secret-header" },
      defaultModel: "claude-sonnet-4-5",
      models: ["claude-sonnet-4-5"],
    });
    expect(shareUrl.startsWith("epx://provider?")).toBe(true);
    expect(shareUrl).not.toContain("sk-ant-1234567890");
    expect(shareUrl).not.toContain("sk-ant-pool-key");
    expect(shareUrl).not.toContain("secret-header");
    expect(shareUrl).not.toContain("apiKey");
    expect(shareUrl).not.toContain("headers");
    expect(maskDeepLinkApiKey("sk-123456789")).toBe("••••••••");
    expect(maskDeepLinkApiKey("sk-1234567890123")).toBe("sk-1...0123");
  });

  test("rejects oversized URLs/payloads, deep JSON, >64 models, control chars, unknown adapters, antigravity ToS OAuth, and SSRF targets", async () => {
    await expect(previewProviderDeepLink(`epx://provider?name=a&adapter=openai-chat&baseUrl=https://example.com&note=${"x".repeat(MAX_EPX_DEEP_LINK_BYTES)}`))
      .rejects.toThrow(/8192|length|large/i);

    // Hostname resolving to cloud metadata must remain blocked even with caller allowPrivateNetwork opt-in
    await expect(applyProviderDeepLink(
      "epx://provider?name=evil-dns&adapter=openai-chat&baseUrl=https://rebind.example.com/v1",
      {
        allowPrivateNetwork: true,
        lookupDns: async () => [{ address: "169.254.169.254", family: 4 }],
      },
    )).rejects.toThrow(/metadata|blocked/i);

    // Build payload > MAX_DECODED_PAYLOAD_BYTES using nested whitespace/short url? Wait: base64url of 16385 bytes is > 8192 bytes!
    // Verify depth > 8 fails even within 8192 bytes
    const deepPayload = toBase64Url({
      name: "deep",
      adapter: "openai-chat",
      baseUrl: "https://example.com",
      extra: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } },
    });
    await expect(previewProviderDeepLink(`epx://provider?payload=${deepPayload}`)).rejects.toThrow(/depth|nesting/i);

    // >64 models
    const manyModels = Array.from({ length: 65 }, (_, i) => `m-${i}`).join(",");
    await expect(previewProviderDeepLink(`epx://provider?name=p1&adapter=openai-chat&baseUrl=https://example.com&models=${encodeURIComponent(manyModels)}`))
      .rejects.toThrow(/64|models/i);

    // Control characters
    await expect(previewProviderDeepLink("epx://provider?name=p1&adapter=openai-chat&baseUrl=https://example.com&note=bad%07char"))
      .rejects.toThrow(/control/i);

    // Unknown adapter
    await expect(previewProviderDeepLink("epx://provider?name=p1&adapter=nonexistent-adapter&baseUrl=https://example.com"))
      .rejects.toThrow(/adapter/i);

    // Antigravity ToS-gated refusal
    await expect(previewProviderDeepLink("epx://provider?name=antigravity&adapter=agy-acp&baseUrl=https://cloudcode-pa.googleapis.com"))
      .rejects.toThrow(/antigravity|consent|oauth|refused/i);

    // Metadata endpoint unconditionally blocked even when allowPrivateNetwork is requested
    await expect(applyProviderDeepLink(
      "epx://provider?name=meta&adapter=openai-chat&baseUrl=http://169.254.169.254/latest&allowPrivateNetwork=true",
      { allowPrivateNetwork: true },
    )).rejects.toThrow(/metadata/i);

    // Untrusted allowPrivateNetwork=true in URL CANNOT auto-enable private network access without caller opt-in
    const privateUrl = "epx://provider?name=local-vllm&adapter=openai-chat&baseUrl=http://127.0.0.1:8000/v1&allowPrivateNetwork=true";
    const privPreview = await previewProviderDeepLink(privateUrl);
    expect(privPreview.requiresPrivateNetworkOptIn).toBe(true);
    expect(privPreview.privateNetworkOptInGranted).toBe(false);
    expect(privPreview.canImport).toBe(false);

    await expect(applyProviderDeepLink(privateUrl)).rejects.toThrow(/private/i);

    const optInApplied = await applyProviderDeepLink(privateUrl, { allowPrivateNetwork: true });
    expect(optInApplied.name).toBe("local-vllm");
  });

  test("management routes preview, apply, and build keyless share URLs cleanly", async () => {
    const config = getDefaultConfig();
    saveConfig(config);
    const deps = {
      saveConfig: (c: typeof config) => saveConfig(c),
      saveConfigPreservingClaudeCode: (c: typeof config) => saveConfig(c),
      onQuit: () => {},
      convergeCodexCatalog: async () => ({ status: "ok" as const, modelCount: 0 }),
    } as never;

    const callMgmt = (req: Request) => handleManagementAPI(req, new URL(req.url), config, deps);

    const importUrl = "epx://provider?name=moonshot-link&adapter=openai-chat&baseUrl=https%3A%2F%2Fapi.moonshot.cn%2Fv1&apiKey=sk-moon-12345678&defaultModel=moonshot-v1";
    const previewRes = await callMgmt(makeDeepLinkRequest("/api/providers/import-url/preview", "POST", { url: importUrl }));
    expect(previewRes?.status).toBe(200);
    const previewBody = await previewRes!.text();
    expect(previewBody).not.toContain("sk-moon-12345678");

    const applyRes = await callMgmt(makeDeepLinkRequest("/api/providers/import-url", "POST", { url: importUrl }));
    expect(applyRes?.status).toBe(200);
    expect(config.providers["moonshot-link"]?.apiKey).toBe("sk-moon-12345678");

    const shareRes = await callMgmt(makeDeepLinkRequest("/api/providers/share-url?provider=moonshot-link", "GET"));
    expect(shareRes?.status).toBe(200);
    const shareData = await shareRes!.json() as { url: string };
    expect(shareData.url).toContain("name=moonshot-link");
    expect(shareData.url).not.toContain("sk-moon-12345678");
  });

  test("CLI provider import-url and share-url handle --preview, --yes, and keyless export", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    const deps = { findLiveProxy: async () => null };
    try {
      const url = "epx://provider?name=groq-cli&adapter=openai-chat&baseUrl=https%3A%2F%2Fapi.groq.com%2Fopenai%2Fv1&apiKey=gsk-secret-9999&defaultModel=llama-3.3-70b";
      const previewCode = await handleProviderImportUrlCommand([url, "--preview", "--json"], deps);
      expect(previewCode).toBe(0);
      expect(logs.at(-1)!).not.toContain("gsk-secret-9999");

      const noYesCode = await handleProviderImportUrlCommand([url, "--json"], deps);
      expect(noYesCode).toBe(2);

      const applyCode = await handleProviderImportUrlCommand([url, "--yes", "--json"], deps);
      expect(applyCode).toBe(0);
      expect(JSON.parse(logs.at(-1)!).name).toBe("groq-cli");

      const shareCode = await handleProviderShareUrlCommand(["groq-cli", "--json"], deps);
      expect(shareCode).toBe(0);
      const shared = JSON.parse(logs.at(-1)!) as { url: string };
      expect(shared.url).toContain("name=groq-cli");
      expect(shared.url).not.toContain("gsk-secret-9999");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});
