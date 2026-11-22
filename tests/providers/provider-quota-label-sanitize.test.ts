import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { saveCredential } from "../../src/oauth/store";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  setProviderQuotaBeforePublishForTests,
} from "../../src/providers/quota";
import type { EpxConfig } from "../../src/types";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const previousEasyproxyHome = process.env.EASYPROXY_HOME;
const previousCodexHome = process.env.CODEX_HOME;

let easyproxyHome: string;
let codexHome: string;

beforeEach(() => {
  for (const key of proxyKeys) delete process.env[key];
  easyproxyHome = mkdtempSync(join(tmpdir(), "epx-quota-"));
  codexHome = mkdtempSync(join(tmpdir(), "codex-quota-"));
  process.env.EASYPROXY_HOME = easyproxyHome;
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "chatgpt-main-access", account_id: "chatgpt-main-account" },
  }));
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
});

afterEach(() => {
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
  if (previousEasyproxyHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousEasyproxyHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(easyproxyHome);
  removeTreeWithRetry(codexHome);
});

describe("fetchProviderQuotaReports", () => {
  test("Anthropic report strips terminal controls from model-scoped quota labels", async () => {
    await saveCredential("anthropic", { access: "claude-access-secret", refresh: "claude-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => Response.json({
      limits: [{
        kind: "weekly_scoped",
        scope: { model: { display_name: "Other\u001b]52;c;UFdORUQ=\u0007 model\u009b31m" } },
        percent: 33,
      }],
    })) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com/v1" } },
    } as EpxConfig, true);

    // An unrecognized display_name is dropped entirely: sanitized residue must not
    // reach the quota line, so the window is omitted rather than relabeled.
    expect(result.reports[0]?.quota.customWindows ?? []).toEqual([]);
  });

  test("Anthropic report still publishes recognized model-scoped quota labels", async () => {
    await saveCredential("anthropic", { access: "claude-access-secret", refresh: "claude-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => Response.json({
      limits: [{
        kind: "weekly_scoped",
        scope: { model: { display_name: "Claude Opus 4.7" } },
        percent: 41,
      }],
    })) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com/v1" } },
    } as EpxConfig, true);

    expect(result.reports[0]?.quota.customWindows).toEqual([{
      label: "Opus",
      scope: "model",
      percent: 41,
    }]);
  });
});
