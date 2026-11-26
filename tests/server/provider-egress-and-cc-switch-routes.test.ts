import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import {
  resolveProviderApiKey,
  setProviderKeychainEntryFactoryForTests,
  type ProviderKeychainEntry,
} from "../../src/providers/key-store";
import {
  CC_SWITCH_IMPORT_JOURNAL_FILENAME,
  CcSwitchImportError,
  runCcSwitchLiveProviderImport,
  runCcSwitchProviderImport,
} from "../../src/providers/cc-switch-import";
import { handleManagementAPI } from "../../src/server/management-api";
import { bindUpstreamHistorySlimConfig, currentUpstreamHistorySlim } from "../../src/server/responses/history-slim";
import type { EpxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY_ANT_BEARER = ["ccs", "ant", "bearer", "111122223333"].join("-");
const KEY_ANT_APIKEY = ["ccs", "ant", "xapikey", "444455556666"].join("-");
const KEY_CODEX_AUTH = ["ccs", "codex", "auth", "777788889999"].join("-");
const KEY_CODEX_TOML = ["ccs", "codex", "toml", "aaaabbbbcccc"].join("-");
const KEY_GEMINI = ["ccs", "gemini", "key", "ddddeeeeffff"].join("-");
const KEY_OPENAI = ["ccs", "openai", "key", "000011112222"].join("-");

let home = "";
let previousHome: string | undefined;
let previousUserHome: string | undefined;
let releaseSpend: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  previousUserHome = process.env.HOME;
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "epx-egress-ccswitch-")));
  process.env.EASYPROXY_HOME = home;
  process.env.HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  bindUpstreamHistorySlimConfig({ defaultProvider: "alpha", providers: {} } as EpxConfig);
});

afterEach(() => {
  setProviderKeychainEntryFactoryForTests(null);
  releaseSpend?.();
  releaseSpend = undefined;
  bindUpstreamHistorySlimConfig({ defaultProvider: "alpha", providers: {} } as EpxConfig);
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  if (previousUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousUserHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function callMgmt(method: string, path: string, cfg: EpxConfig, body?: unknown) {
  const req = new Request(`http://127.0.0.1:10100${path}`, {
    method,
    headers: {
      host: "127.0.0.1:10100",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), cfg, {});
  const json = res ? (await res.json()) as unknown : null;
  return { status: res?.status ?? 0, json };
}

describe("Stage 3B provider egress, upstreamHistorySlim, and cc-switch management routes", () => {
  test("GET /api/providers redacts proxy credentials and PUT /api/providers/egress validates & clears egress fields", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-alpha-test",
          proxy: "http://proxyuser:secretpass@127.0.0.1:8888",
          noProxy: ["localhost", ".internal"],
          models: ["gpt-5"],
        },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
          models: ["gemini-2.5-pro"],
        },
      },
    };
    saveConfig(cfg);

    const list = await callMgmt("GET", "/api/providers", cfg);
    expect(list.status).toBe(200);
    const rows = list.json as Array<Record<string, unknown>>;
    const alphaRow = rows.find(r => r.name === "alpha")!;
    expect(alphaRow.hasProxy).toBe(true);
    expect(alphaRow.proxy).toBeUndefined();
    expect(String(alphaRow.proxyLabel)).not.toContain("secretpass");
    expect(String(alphaRow.proxyLabel)).not.toContain("proxyuser");
    expect(alphaRow.proxyLabel).toBe("http://127.0.0.1:8888/");
    expect(alphaRow.noProxy).toEqual(["localhost", ".internal"]);

    // Reject tlsProfile on non-antigravity provider.
    const badTls = await callMgmt("PUT", "/api/providers/egress?name=alpha", cfg, {
      tlsProfile: "antigravity-browser",
    });
    expect(badTls.status).toBe(400);

    // Reject unknown provider.
    const unknown = await callMgmt("PUT", "/api/providers/egress?name=missing", cfg, { proxy: null });
    expect(unknown.status).toBe(404);

    // Update google-antigravity proxy + tlsProfile + noProxy.
    const setAgy = await callMgmt("PUT", "/api/providers/egress?name=google-antigravity", cfg, {
      proxy: "http://user:pw@127.0.0.1:7890",
      noProxy: "127.0.0.1,localhost",
      tlsProfile: "antigravity-browser",
    });
    expect(setAgy.status).toBe(200);
    const agyBody = setAgy.json as Record<string, unknown>;
    expect(agyBody.hasProxy).toBe(true);
    expect(String(agyBody.proxyLabel)).not.toContain("pw");
    expect(agyBody.noProxy).toBe("127.0.0.1,localhost");
    expect(cfg.providers["google-antigravity"]?.tlsProfile).toBe("antigravity-browser");

    // Clear proxy while preserving noProxy.
    const cleared = await callMgmt("PUT", "/api/providers/egress?name=google-antigravity", cfg, {
      proxy: null,
    });
    expect(cleared.status).toBe(200);
    expect((cleared.json as Record<string, unknown>).hasProxy).toBe(false);
    expect(cfg.providers["google-antigravity"]?.proxy).toBeUndefined();
    expect(cfg.providers["google-antigravity"]?.noProxy).toBe("127.0.0.1,localhost");
  });

  test("GET/PUT /api/settings exposes, validates, persists, and binds upstreamHistorySlim", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          models: ["gpt-5"],
        },
      },
    };
    saveConfig(cfg);

    const initial = await callMgmt("GET", "/api/settings", cfg);
    expect(initial.status).toBe(200);
    expect((initial.json as Record<string, unknown>).upstreamHistorySlim).toBe("off");

    const invalid = await callMgmt("PUT", "/api/settings", cfg, { upstreamHistorySlim: "bogus" });
    expect(invalid.status).toBe(400);

    const enabled = await callMgmt("PUT", "/api/settings", cfg, { upstreamHistorySlim: "codex" });
    expect(enabled.status).toBe(200);
    expect((enabled.json as Record<string, unknown>).upstreamHistorySlim).toBe("codex");
    expect(cfg.upstreamHistorySlim).toBe("codex");
    expect(currentUpstreamHistorySlim()).toBe("codex");
    expect(loadConfig().upstreamHistorySlim).toBe("codex");

    const disabled = await callMgmt("PUT", "/api/settings", cfg, { upstreamHistorySlim: null });
    expect(disabled.status).toBe(200);
    expect((disabled.json as Record<string, unknown>).upstreamHistorySlim).toBe("off");
    expect(cfg.upstreamHistorySlim).toBeUndefined();
    expect(currentUpstreamHistorySlim()).toBe("off");
  });

  test("POST /api/providers/cc-switch/{preview,apply,restore} enforces explicit consent and atomic rollback", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-alpha",
          models: ["gpt-5"],
        },
      },
    };
    saveConfig(cfg);

    const ccPath = join(home, "cc-switch-export.json");
    writeFileSync(ccPath, JSON.stringify({
      claude: {
        providers: {
          "ccs-one": {
            id: "ccs-one",
            name: "Imported Claude Relay",
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: "https://relay-a.example.com/v1",
                ANTHROPIC_MODEL: "claude-sonnet-4-5",
              },
            },
          },
        },
      },
      codex: {
        providers: {
          "ccs-two": {
            id: "ccs-two",
            name: "Imported Codex Relay",
            settingsConfig: {
              config: 'base_url = "https://relay-b.example.com/v1"\nmodel = "gpt-5.2"',
            },
          },
        },
      },
    }), "utf8");

    // 1. Preview returns candidates without mutating config.
    const preview = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: ccPath });
    expect(preview.status).toBe(200);
    const previewBody = preview.json as { available: boolean; journalActive: boolean; eligible: number; providers: Array<{ name: string }> };
    expect(previewBody.available).toBe(true);
    expect(previewBody.journalActive).toBe(false);
    expect(previewBody.eligible).toBe(2);
    expect(previewBody.providers).toHaveLength(2);
    expect(Object.keys(cfg.providers)).toEqual(["alpha"]);

    // 2. Apply without consent fails closed (400 cc_switch_consent_required).
    const refused = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      sourcePath: ccPath,
      selectedProviders: [previewBody.providers[0]!.name],
    });
    expect(refused.status).toBe(400);
    expect((refused.json as { code: string }).code).toBe("cc_switch_consent_required");
    expect(Object.keys(cfg.providers)).toEqual(["alpha"]);

    // 3. Apply with consent: true imports only the selected candidate.
    const targetName = previewBody.providers[0]!.name;
    const applied = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      consent: true,
      sourcePath: ccPath,
      selectedProviders: [targetName],
    });
    expect(applied.status).toBe(200);
    const appliedBody = applied.json as { imported: number; journalActive: boolean };
    expect(appliedBody.imported).toBe(1);
    expect(appliedBody.journalActive).toBe(true);
    expect(cfg.providers[targetName]).toBeDefined();
    expect(cfg.providers[previewBody.providers[1]!.name]).toBeUndefined();
    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as EpxConfig;
    expect(persisted.providers[targetName]).toBeDefined();

    // 4. Restore rolls back imported provider and clears journal.
    const restored = await callMgmt("POST", "/api/providers/cc-switch/restore", cfg, {});
    expect(restored.status).toBe(200);
    const restoredBody = restored.json as { restored: number; journalActive: boolean };
    expect(restoredBody.restored).toBe(1);
    expect(restoredBody.journalActive).toBe(false);
    expect(cfg.providers[targetName]).toBeUndefined();
    expect(Object.keys(cfg.providers)).toEqual(["alpha"]);
  });

  test("CC-Switch live JSON and SQLite routes migrate API keys with consent, keychain, rollback, and preserve CLI keyless contract", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-alpha",
          models: ["gpt-5"],
        },
      },
    };
    saveConfig(cfg);

    const ccJsonPath = join(home, "cc-switch-keys.json");
    writeFileSync(ccJsonPath, JSON.stringify({
      claude: {
        providers: {
          "ccs-claude-auth": {
            id: "ccs-claude-auth",
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: "https://claude-relay-one.example.com",
                ANTHROPIC_AUTH_TOKEN: KEY_ANT_BEARER,
                ANTHROPIC_MODEL: "claude-sonnet-4-5",
              },
            },
          },
          "ccs-both": {
            id: "ccs-both",
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: "https://claude-key.example.com",
                ANTHROPIC_API_KEY: KEY_ANT_APIKEY,
                ANTHROPIC_AUTH_TOKEN: KEY_ANT_BEARER,
              },
            },
          },
        },
      },
      codex: {
        providers: {
          "ccs-codex-toml": {
            id: "ccs-codex-toml",
            settingsConfig: {
              config: `model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://codex-toml.example.com/v1"\nmodel = "gpt-5.2"\napi_key = "${KEY_CODEX_TOML}"`,
            },
          },
        },
      },
      gemini: {
        providers: {
          "ccs-gem": {
            id: "ccs-gem",
            settingsConfig: {
              env: {
                GOOGLE_GEMINI_BASE_URL: "https://gem.example.com/v1beta",
                GEMINI_API_KEY: KEY_GEMINI,
                GEMINI_MODEL: "gemini-2.5-pro",
              },
            },
          },
        },
      },
      openai: {
        providers: {
          "ccs-oai-keyless": {
            id: "ccs-oai-keyless",
            settingsConfig: {
              baseUrl: "https://oai-keyless.example.com/v1",
              model: "gpt-4.1",
            },
          },
          "ccs-oai-top-envkey": {
            id: "ccs-oai-top-envkey",
            settingsConfig: {
              baseUrl: "https://oai-top.example.com/v1",
              model: "gpt-4.1",
              OPENAI_API_KEY: KEY_OPENAI,
            },
          },
        },
      },
    }), "utf8");

    const decodedDuringPreview: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const s = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedDuringPreview.push(s);
      return s;
    });
    let previewJsonResp;
    try {
      previewJsonResp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: ccJsonPath });
    } finally {
      decodeSpy.mockRestore();
    }
    expect(previewJsonResp.status).toBe(200);
    const previewJsonBody = previewJsonResp.json as {
      eligible: number;
      keychainAvailable: boolean;
      providers: Array<{ name: string; hasApiKey?: boolean; apiKey?: unknown }>;
    };
    expect(previewJsonBody.eligible).toBe(6);
    expect(typeof previewJsonBody.keychainAvailable).toBe("boolean");
    const previewText = JSON.stringify(previewJsonResp.json);
    for (const secret of [KEY_ANT_BEARER, KEY_ANT_APIKEY, KEY_CODEX_TOML, KEY_GEMINI, KEY_OPENAI]) {
      expect(previewText).not.toContain(secret);
      expect(decodedDuringPreview.join("\n")).not.toContain(secret);
    }
    const byName = new Map(previewJsonBody.providers.map(p => [p.name, p]));
    expect(byName.get("ccs-claude-auth")?.hasApiKey).toBe(true);
    expect(byName.get("ccs-both")?.hasApiKey).toBe(true);
    expect(byName.get("ccs-codex-toml")?.hasApiKey).toBe(true);
    expect(byName.get("ccs-gem")?.hasApiKey).toBe(true);
    expect(byName.get("ccs-oai-keyless")?.hasApiKey).toBe(false);
    expect(byName.get("ccs-oai-top-envkey")?.hasApiKey).toBe(true);

    // Service-level consent boundary blocks unconsented live apply directly.
    expect(() => runCcSwitchLiveProviderImport({
      mode: "apply",
      config: cfg,
      saveConfig,
      sourcePath: ccJsonPath,
      consent: false,
    })).toThrow(CcSwitchImportError);

    // Apply with includeApiKeys: false imports providers keyless without decoding secrets.
    const decodedDuringKeyless: string[] = [];
    const decodeSpyKeyless = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const s = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedDuringKeyless.push(s);
      return s;
    });
    let keylessApply;
    try {
      keylessApply = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
        consent: true,
        sourcePath: ccJsonPath,
        includeApiKeys: false,
      });
    } finally {
      decodeSpyKeyless.mockRestore();
    }
    expect(keylessApply.status).toBe(200);
    expect((keylessApply.json as { imported: number; importedWithApiKeys: number }).imported).toBe(6);
    expect((keylessApply.json as { importedWithApiKeys: number }).importedWithApiKeys).toBe(0);
    for (const secret of [KEY_ANT_BEARER, KEY_ANT_APIKEY, KEY_CODEX_TOML, KEY_GEMINI, KEY_OPENAI]) {
      expect(decodedDuringKeyless.join("\n")).not.toContain(secret);
    }
    expect(cfg.providers["ccs-claude-auth"]?.apiKey).toBeUndefined();
    expect(cfg.providers["ccs-claude-auth"]?.authMode).toBeUndefined();

    // Restore keyless import, then apply WITH API keys (default includeApiKeys: true).
    expect((await callMgmt("POST", "/api/providers/cc-switch/restore", cfg, {})).status).toBe(200);

    const keyedApply = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      consent: true,
      sourcePath: ccJsonPath,
    });
    expect(keyedApply.status).toBe(200);
    const keyedApplyText = JSON.stringify(keyedApply.json);
    for (const secret of [KEY_ANT_BEARER, KEY_ANT_APIKEY, KEY_CODEX_TOML, KEY_GEMINI, KEY_OPENAI]) {
      expect(keyedApplyText).not.toContain(secret);
    }
    const keyedBody = keyedApply.json as { imported: number; importedWithApiKeys: number; storedInKeychain: number };
    expect(keyedBody.imported).toBe(6);
    expect(keyedBody.importedWithApiKeys).toBe(5);
    expect(keyedBody.storedInKeychain).toBe(0);

    expect(cfg.providers["ccs-claude-auth"]?.authMode).toBe("key");
    expect(cfg.providers["ccs-claude-auth"]?.apiKey).toBe(KEY_ANT_BEARER);
    expect(cfg.providers["ccs-claude-auth"]?.apiKeyTransport).toBe("bearer");

    expect(cfg.providers["ccs-both"]?.authMode).toBe("key");
    expect(cfg.providers["ccs-both"]?.apiKey).toBe(KEY_ANT_APIKEY);
    expect(cfg.providers["ccs-both"]?.apiKeyTransport).toBeUndefined();

    expect(cfg.providers["ccs-codex-toml"]?.authMode).toBe("key");
    expect(cfg.providers["ccs-codex-toml"]?.apiKey).toBe(KEY_CODEX_TOML);

    expect(cfg.providers["ccs-gem"]?.authMode).toBe("key");
    expect(cfg.providers["ccs-gem"]?.apiKey).toBe(KEY_GEMINI);

    expect(cfg.providers["ccs-oai-keyless"]?.authMode).toBeUndefined();
    expect(cfg.providers["ccs-oai-keyless"]?.apiKey).toBeUndefined();

    expect(cfg.providers["ccs-oai-top-envkey"]?.authMode).toBe("key");
    expect(cfg.providers["ccs-oai-top-envkey"]?.apiKey).toBe(KEY_OPENAI);

    // Journal never stores plaintext API keys.
    const journalText = readFileSync(join(home, CC_SWITCH_IMPORT_JOURNAL_FILENAME), "utf8");
    for (const secret of [KEY_ANT_BEARER, KEY_ANT_APIKEY, KEY_CODEX_TOML, KEY_GEMINI, KEY_OPENAI]) {
      expect(journalText).not.toContain(secret);
    }

    expect((await callMgmt("POST", "/api/providers/cc-switch/restore", cfg, {})).status).toBe(200);

    // SQLite + Keychain flow (with fake keychain factory + rollback + restore cleanup).
    const keychainMap = new Map<string, string>();
    let failSecondReadback = false;
    setProviderKeychainEntryFactoryForTests((_service, account): ProviderKeychainEntry => ({
      getPassword: () => (failSecondReadback && account === "sql-openai" ? "corrupted" : (keychainMap.get(account) ?? null)),
      setPassword: (pw: string) => { keychainMap.set(account, pw); },
      deletePassword: () => keychainMap.delete(account),
    }));

    const dbPath = join(home, "cc-switch.db");
    const db = new Database(dbPath, { create: true });
    try {
      db.run(`
        CREATE TABLE providers (
          id TEXT NOT NULL,
          app_type TEXT NOT NULL,
          name TEXT NOT NULL,
          settings_config TEXT NOT NULL,
          sort_index INTEGER DEFAULT 0,
          PRIMARY KEY (id, app_type)
        )
      `);
      const ins = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?1, ?2, ?3, ?4, ?5)");
      ins.run("sql-codex", "codex", "SQL Codex", JSON.stringify({
        auth: { OPENAI_API_KEY: KEY_CODEX_AUTH },
        config: 'base_url = "https://sql-codex.example.com/v1"\nmodel = "gpt-5.2"',
      }), 1);
      ins.run("sql-openai", "openai", "SQL OpenAI", JSON.stringify({
        baseUrl: "https://sql-oai.example.com/v1",
        model: "qwen3",
        apiKey: KEY_OPENAI,
      }), 2);
      ins.finalize();
    } finally {
      db.close();
    }

    const sqlPreview = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: dbPath });
    expect(sqlPreview.status).toBe(200);
    const sqlPreviewBody = sqlPreview.json as {
      keychainAvailable: boolean;
      providers: Array<{ name: string; hasApiKey?: boolean }>;
    };
    expect(sqlPreviewBody.keychainAvailable).toBe(true);
    expect(sqlPreviewBody.providers.every(p => p.hasApiKey === true)).toBe(true);
    expect(JSON.stringify(sqlPreview.json)).not.toContain(KEY_CODEX_AUTH);
    expect(JSON.stringify(sqlPreview.json)).not.toContain(KEY_OPENAI);

    // Keychain verification mismatch rolls back previously written keychain entries.
    failSecondReadback = true;
    const kcFail = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      consent: true,
      sourcePath: dbPath,
      storeInKeychain: true,
    });
    expect(kcFail.status).toBe(400);
    expect(keychainMap.size).toBe(0);
    expect(cfg.providers["sql-codex"]).toBeUndefined();
    expect(cfg.providers["sql-openai"]).toBeUndefined();

    // Successful Keychain import stores references in config.json and keys in keychain.
    failSecondReadback = false;
    const kcOk = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      consent: true,
      sourcePath: dbPath,
      storeInKeychain: true,
    });
    expect(kcOk.status).toBe(200);
    expect((kcOk.json as { imported: number; importedWithApiKeys: number; storedInKeychain: number })).toMatchObject({
      imported: 2,
      importedWithApiKeys: 2,
      storedInKeychain: 2,
    });
    expect(cfg.providers["sql-codex"]?.apiKey).toBe("keychain:sql-codex");
    expect(cfg.providers["sql-openai"]?.apiKey).toBe("keychain:sql-openai");
    expect(keychainMap.get("sql-codex")).toBe(KEY_CODEX_AUTH);
    expect(keychainMap.get("sql-openai")).toBe(KEY_OPENAI);
    expect(resolveProviderApiKey("keychain:sql-codex")).toBe(KEY_CODEX_AUTH);

    // Restore cleans up both config.json and keychain entries.
    const kcRestored = await callMgmt("POST", "/api/providers/cc-switch/restore", cfg, {});
    expect(kcRestored.status).toBe(200);
    expect(keychainMap.size).toBe(0);
    expect(cfg.providers["sql-codex"]).toBeUndefined();
    expect(cfg.providers["sql-openai"]).toBeUndefined();

    // Existing CLI keyless contract remains strictly keyless on the exact same SQLite source.
    const cliResult = await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });
    expect(cliResult.mode).toBe("apply");
    expect((cliResult as { imported: number; providers: Array<{ hasApiKey?: unknown }> }).imported).toBe(2);
    expect((cliResult as { providers: Array<{ hasApiKey?: unknown }> }).providers[0]?.hasApiKey).toBeUndefined();
    const afterCli = loadConfig();
    expect(afterCli.providers["sql-codex"]?.apiKey).toBeUndefined();
    expect(afterCli.providers["sql-codex"]?.authMode).toBeUndefined();
  });

  test("CC-Switch routes reject arbitrary files, traversal, symlinks, hardlinks, active WAL, and malformed secret markers", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-alpha",
          models: ["gpt-5"],
        },
      },
    };
    saveConfig(cfg);

    writeFileSync(join(home, CC_SWITCH_IMPORT_JOURNAL_FILENAME), JSON.stringify({ openai: { providers: {} } }), "utf8");
    writeFileSync(join(home, "auth.json"), JSON.stringify({}), "utf8");
    writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({}), "utf8");
    writeFileSync(join(home, "local-credentials.json"), JSON.stringify({}), "utf8");
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "p.json"), JSON.stringify({ openai: { providers: {} } }), "utf8");

    // Relative paths, disallowed extensions, and EasyProxy runtime files are refused at the route boundary.
    for (const badPath of [
      "relative.json",
      "../escape.json",
      "/etc/passwd",
      join(home, ".env"),
      join(home, "secret.pem"),
      join(home, "cc-switch.db-wal"),
      join(home, "config.json"),
      join(home, "CONFIG.JSON"),
      join(home, CC_SWITCH_IMPORT_JOURNAL_FILENAME),
      join(home, "auth.json"),
      join(home, "codex-accounts.json"),
      join(home, "local-credentials.json"),
      join(home, "profiles", "p.json"),
    ]) {
      const resp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: badPath });
      expect(resp.status).toBe(400);
      expect((resp.json as { code: string }).code).toBe("invalid_source_path");
    }
    unlinkSync(join(home, CC_SWITCH_IMPORT_JOURNAL_FILENAME));
    unlinkSync(join(home, "auth.json"));
    unlinkSync(join(home, "codex-accounts.json"));
    unlinkSync(join(home, "local-credentials.json"));

    // Symlink and hardlink files are rejected.
    const realJson = join(home, "plain.json");
    writeFileSync(realJson, JSON.stringify({ openai: { providers: {} } }), "utf8");
    const symJson = join(home, "sym.json");
    symlinkSync(realJson, symJson);
    const symResp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: symJson });
    expect(symResp.status).toBe(400);

    const subDir = join(home, "linked-dir");
    mkdirSync(subDir, { recursive: true });
    const linkedJson = join(subDir, "hard.json");
    linkSync(realJson, linkedJson);
    const hardResp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: linkedJson });
    expect(hardResp.status).toBe(400);

    // Uncheckpointed SQLite WAL is rejected; malformed settings_config JSON in SQLite fails safely.
    const walDbPath = join(home, "wal-active.db");
    const walDb = new Database(walDbPath, { create: true });
    walDb.run("PRAGMA journal_mode = WAL;");
    walDb.run("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER DEFAULT 0)");
    walDb.run("INSERT INTO providers VALUES ('w1', 'openai', 'W1', '{\"baseUrl\":\"https://w.example.com/v1\"}', 1)");
    try {
      const walResp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: walDbPath });
      expect(walResp.status).toBe(400);
    } finally {
      walDb.close();
    }

    const malformedDbPath = join(home, "malformed-row.db");
    const malformedDb = new Database(malformedDbPath, { create: true });
    malformedDb.run("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER DEFAULT 0)");
    malformedDb.run("INSERT INTO providers VALUES ('bad-json', 'openai', 'Bad', '{not-json', 1)");
    malformedDb.run(`INSERT INTO providers VALUES ('ok-row', 'openai', 'Ok', '${JSON.stringify({ baseUrl: "https://ok.example.com/v1", apiKey: KEY_OPENAI })}', 2)`);
    malformedDb.close();
    const malformedResp = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: malformedDbPath });
    expect(malformedResp.status).toBe(200);
    expect((malformedResp.json as { invalid: number; eligible: number }).invalid).toBe(1);
    expect((malformedResp.json as { invalid: number; eligible: number }).eligible).toBe(1);

    // Adversarial/reference API-key placeholders never register as valid keys and are never stored.
    const advJson = join(home, "adversarial-keys.json");
    writeFileSync(advJson, JSON.stringify({
      openai: {
        providers: {
          "adv-ref": { id: "adv-ref", settingsConfig: { baseUrl: "https://a.example.com/v1", apiKey: "keychain:other" } },
          "adv-env": { id: "adv-env", settingsConfig: { baseUrl: "https://b.example.com/v1", apiKey: "${OPENAI_API_KEY}" } },
          "adv-interp": { id: "adv-interp", settingsConfig: { baseUrl: "https://e.example.com/v1", apiKey: "sk-${LEAKED_ENV}" } },
          "adv-nl": { id: "adv-nl", settingsConfig: { baseUrl: "https://c.example.com/v1", apiKey: "bad\nline" } },
          "adv-big": { id: "adv-big", settingsConfig: { baseUrl: "https://d.example.com/v1", apiKey: "k".repeat(4097) } },
        },
      },
    }), "utf8");
    const advPreview = await callMgmt("POST", "/api/providers/cc-switch/preview", cfg, { sourcePath: advJson });
    expect(advPreview.status).toBe(200);
    expect((advPreview.json as { providers: Array<{ hasApiKey?: boolean }> }).providers.every(p => p.hasApiKey === false)).toBe(true);

    const advApply = await callMgmt("POST", "/api/providers/cc-switch/apply", cfg, {
      consent: true,
      sourcePath: advJson,
    });
    expect(advApply.status).toBe(200);
    expect((advApply.json as { imported: number; importedWithApiKeys: number })).toMatchObject({
      imported: 5,
      importedWithApiKeys: 0,
    });
    for (const name of ["adv-ref", "adv-env", "adv-interp", "adv-nl", "adv-big"]) {
      expect(cfg.providers[name]?.apiKey).toBeUndefined();
      expect(cfg.providers[name]?.authMode).toBeUndefined();
    }
  });

  test("CC-Switch rollback restores pre-existing OS keychain secret instead of deleting it and emits management CORS headers", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: { alpha: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", authMode: "key", apiKey: "k", models: ["gpt-5"] } },
    };
    saveConfig(cfg);

    const keychainMap = new Map<string, string>([
      ["ccswitch-ccs-existing", "prior-super-secret"],
    ]);
    setProviderKeychainEntryFactoryForTests((_service, account) => ({
      getPassword: () => keychainMap.get(account) ?? null,
      setPassword: (secret: string) => { keychainMap.set(account, secret); },
      deletePassword: () => keychainMap.delete(account),
    }));

    const ccJsonPath = join(home, "cc-rollback-kc.json");
    writeFileSync(ccJsonPath, JSON.stringify({
      openai: {
        providers: {
          "ccs-existing": {
            id: "ccs-existing",
            settingsConfig: { baseUrl: "https://rb.example.com/v1", apiKey: KEY_OPENAI },
          },
        },
      },
    }), "utf8");

    expect(() => runCcSwitchLiveProviderImport({
      mode: "apply",
      config: cfg,
      saveConfig: () => { throw new Error("disk write failed"); },
      sourcePath: ccJsonPath,
      consent: true,
      includeApiKeys: true,
      storeInKeychain: true,
    })).toThrow(CcSwitchImportError);
    // Prior secret must survive rollback untouched rather than being deleted.
    expect(keychainMap.get("ccswitch-ccs-existing")).toBe("prior-super-secret");

    // Management CC-Switch routes include Vary: Origin / Access-Control-Allow-Origin headers on responses.
    const corsReq = new Request("http://127.0.0.1:10100/api/providers/cc-switch/preview", {
      method: "POST",
      headers: {
        host: "127.0.0.1:10100",
        origin: "http://127.0.0.1:10100",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourcePath: ccJsonPath }),
    });
    const corsRes = await handleManagementAPI(corsReq, new URL(corsReq.url), cfg, {});
    expect(corsRes?.status).toBe(200);
    expect(corsRes?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:10100");
    expect(corsRes?.headers.get("vary")).toContain("Origin");
  });
});
