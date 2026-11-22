import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredCredentials } from "../../src/server/configured-credentials";
import { safeConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { redactSecrets } from "../../src/lib/redact";
import { diagnosticValueAllowed } from "../../src/server/request-log-terminal-status";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/api-key-resolve";
import type { EpxConfig } from "../../src/types";

test("Artificial Analysis credentials are protected and refreshed", () => {
  const dir = mkdtempSync(join(tmpdir(), "epx-aa-credential-"));
  const oldHome = process.env.EASYPROXY_HOME;
  const oldKey = process.env.EPX_TEST_AA_KEY;
  process.env.EASYPROXY_HOME = dir;
  const write = (apiKey: string) => writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: {}, codexRoleCapability: { artificialAnalysis: { apiKey } } }));
  try {
    write("aa-literal-secret-value");
    expect(configuredCredentials().matches("aa-literal-secret-value")).toBe(true);
    process.env.EPX_TEST_AA_KEY = "aa-env-secret-one";
    write("  $EPX_TEST_AA_KEY  ");
    expect(configuredCredentials().matches("aa-env-secret-one")).toBe(true);
    process.env.EPX_TEST_AA_KEY = "aa-env-secret-two";
    expect(configuredCredentials().matches("aa-env-secret-two")).toBe(true);
    expect(configuredCredentials().matches("aa-env-secret-one")).toBe(false);
    expect(diagnosticValueAllowed("harmless_diagnostic")).toBe(true);
    expect(diagnosticValueAllowed("aa-env-secret-two")).toBe(false);
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => "aa-keychain-secret", setPassword: () => {}, deletePassword: () => true }));
    write("  keychain:aa-present  ");
    expect(configuredCredentials().matches("aa-keychain-secret")).toBe(true);
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => null, setPassword: () => {}, deletePassword: () => true }));
    write("  keychain:aa-missing  ");
    expect(configuredCredentials().complete).toBe(false);
    const config = { providers: {}, codexRoleCapability: { artificialAnalysis: { apiKey: "aa-literal-secret-value" } } };
    expect(JSON.stringify(safeConfigDTO(config as EpxConfig))).not.toContain("aa-literal-secret-value");
    expect(JSON.stringify(redactSecrets(config))).not.toContain("aa-literal-secret-value");
  } finally {
    setProviderKeychainEntryFactoryForTests(null);
    if (oldHome === undefined) delete process.env.EASYPROXY_HOME; else process.env.EASYPROXY_HOME = oldHome;
    if (oldKey === undefined) delete process.env.EPX_TEST_AA_KEY; else process.env.EPX_TEST_AA_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/config does not expose the Artificial Analysis key", async () => {
  const secret = "aa-management-fixture-secret";
  const config = { port: 10100, defaultProvider: "openai", providers: {}, codexRoleCapability: { artificialAnalysis: { apiKey: secret } } } as EpxConfig;
  const url = new URL("http://localhost/api/config");
  const response = await handleManagementAPI(new ManagementRequest(url), url, config);
  expect(response?.status).toBe(200);
  expect(await response!.text()).not.toContain(secret);
});
