import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { INTEGRATION_TAB_HASHES, readPageFromHash, resolveAppHashChange } from "../src/app-routing";
import { FILE_CLIENTS, TABS } from "../src/pages/integrations/integration-tabs";
import { readProviderImportUrl, readProviderSettingsTarget } from "../src/protocol-deep-links";
import { DICTS, I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import EcosystemSyncPage from "../src/pages/integrations/EcosystemSyncPage";
import ImportProviderLinkModal from "../src/components/ImportProviderLinkModal";
import StorageProfileBackupCard from "../src/components/StorageProfileBackupCard";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let prevGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const tEn: TFn = (key, vars) => interpolate(DICTS.en[key], vars);

function I18nWrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", setLocale: () => {}, t: tEn }}>
      {children}
    </I18nContext.Provider>
  );
}

beforeEach(() => {
  prevGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof prevGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/sync" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: prevGlobals[key] });
  }
});

describe("Unit 7 GUI integration, deep-link modal, and profile backup card", () => {
  test("sync tab is registered without adding sync to FILE_CLIENTS, and ?import= coexists with ?provider=", () => {
    expect(INTEGRATION_TAB_HASHES).toContain("integrations/sync");
    expect(TABS.some(tab => tab.id === "sync")).toBe(true);
    expect(FILE_CLIENTS.has("sync" as never)).toBe(false);
    expect(readPageFromHash("#integrations/sync")).toBe("integrations");
    expect(resolveAppHashChange("integrations/sync")).toEqual({ page: "integrations", replaceTo: null });

    const importHash = "#providers?import=epx%3A%2F%2Fprovider%3Fname%3Dtest%26adapter%3Dopenai-chat%26baseUrl%3Dhttps%253A%252F%252Fexample.com";
    expect(readProviderImportUrl(importHash)).toContain("epx://provider?");
    expect(readProviderSettingsTarget(importHash)).toBeNull();
  });

  test("EcosystemSyncPage fetches redacted status, previews, applies, and restores", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/ecosystem/sync")) {
        return Response.json({
          schemaVersion: 1,
          clis: {
            claude: { cli: "claude", installed: true, mcpCount: 1, skillCount: 1, mcp: [{ name: "ctx7", transport: "stdio", envKeys: ["TOKEN"], headerKeys: [], digest: "abc" }], skills: [{ slug: "audit", bytes: 42, digest: "def" }], unsupportedMcp: [], warnings: [] },
            codex: { cli: "codex", installed: true, mcpCount: 0, skillCount: 0, mcp: [], skills: [], unsupportedMcp: [], warnings: [] },
            gemini: { cli: "gemini", installed: false, mcpCount: 0, skillCount: 0, mcp: [], skills: [], unsupportedMcp: [], warnings: [] },
            opencode: { cli: "opencode", installed: false, mcpCount: 0, skillCount: 0, mcp: [], skills: [], unsupportedMcp: [], warnings: [] },
          },
          batches: [{ batchId: "sync-1", createdAt: Date.now(), source: "claude", targets: ["codex"], fileCount: 2 }],
        });
      }
      if (url.endsWith("/api/ecosystem/sync/preview")) {
        return Response.json({
          schemaVersion: 1,
          source: "claude",
          targets: ["codex"],
          sourceMcpCount: 1,
          sourceSkillCount: 1,
          plans: { codex: { target: "codex", mcp: [{ name: "ctx7", action: "create" }], skills: [{ slug: "audit", action: "create" }] } },
        });
      }
      if (url.endsWith("/api/ecosystem/sync/apply")) {
        return Response.json({ schemaVersion: 1, batchId: "sync-2", appliedMcpCount: 1, appliedSkillCount: 1 });
      }
      if (url.endsWith("/api/ecosystem/sync/restore")) {
        return Response.json({ schemaVersion: 1, restoredBatchId: "sync-1", restoredFiles: [], removedFiles: [] });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(<I18nWrapper><EcosystemSyncPage apiBase="" active /></I18nWrapper>);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex CLI");
    expect(container.textContent).toContain("ctx7");
    expect(container.textContent).toContain("/audit");

    const sourceTrigger = container.querySelector('#eco-sync-source[role="combobox"]') as HTMLButtonElement | null;
    expect(sourceTrigger).not.toBeNull();
    await act(async () => {
      sourceTrigger!.click();
      await new Promise(r => setTimeout(r, 10));
    });
    const codexOpt = [...document.querySelectorAll('[role="option"]')].find(el => el.getAttribute("data-value") === "codex") as HTMLButtonElement | undefined;
    expect(codexOpt).toBeDefined();
    await act(async () => {
      codexOpt!.click();
      await new Promise(r => setTimeout(r, 10));
    });
    expect(sourceTrigger!.getAttribute("data-value")).toBe("codex");
    const targetBoxes = [...container.querySelectorAll<HTMLInputElement>('.eco-sync-row input[type="checkbox"]')];
    expect(targetBoxes.some(cb => cb.parentElement?.textContent === "Claude Code")).toBe(true);
    // Switch back to claude so preview exercises the claude->codex mock plan
    await act(async () => {
      sourceTrigger!.click();
      await new Promise(r => setTimeout(r, 10));
    });
    const claudeOpt = [...document.querySelectorAll('[role="option"]')].find(el => el.getAttribute("data-value") === "claude") as HTMLButtonElement | undefined;
    await act(async () => {
      claudeOpt!.click();
      await new Promise(r => setTimeout(r, 10));
    });

    const previewBtn = [...container.querySelectorAll("button")].find(b => b.textContent === DICTS.en["ecoSync.preview"]);
    expect(previewBtn).toBeDefined();
    await act(async () => {
      previewBtn!.click();
      await new Promise(r => setTimeout(r, 10));
    });
    expect(container.textContent).toContain("ctx7 (create)");
    expect(container.textContent).toContain("/audit (create)");
    expect(calls.some(c => c.startsWith("POST /api/ecosystem/sync/preview"))).toBe(true);

    await act(async () => { root.unmount(); });
  });

  test("ImportProviderLinkModal auto-previews non-empty initialUrl on mount without auto-importing", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/providers/import-url/preview")) {
        const body = init?.body ? JSON.parse(String(init.body)) as { allowPrivateNetwork?: boolean } : {};
        const allowed = body.allowPrivateNetwork === true;
        return Response.json({
          name: "local-box",
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:8000/v1",
          defaultModel: "llama",
          models: ["llama"],
          hasApiKey: true,
          maskedApiKey: "sk-1...9999",
          requiresPrivateNetworkOptIn: true,
          privateNetworkOptInGranted: allowed,
          conflict: false,
          canImport: allowed,
          blockedReason: allowed ? null : "Explicit private-network opt-in required",
          warnings: [],
        });
      }
      return Response.json({ name: "local-box" });
    }) as unknown as typeof fetch;

    let importedName = "";
    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nWrapper>
          <ImportProviderLinkModal
            apiBase=""
            initialUrl="epx://provider?name=local-box&adapter=openai-chat&baseUrl=http://127.0.0.1:8000/v1"
            onClose={() => {}}
            onImported={name => { importedName = name; }}
          />
        </I18nWrapper>,
      );
      await new Promise(r => setTimeout(r, 10));
    });

    expect(calls).toEqual(["POST /api/providers/import-url/preview"]);
    expect(container.textContent).toContain("sk-1...9999");
    expect(container.textContent).toContain(DICTS.en["deepLinkImport.privateWarning"]);
    const importBtn = [...container.querySelectorAll("button")].find(b => b.textContent === DICTS.en["deepLinkImport.import"]) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(importedName).toBe("");

    // Enabling private-network opt-in refreshes preview and enables explicit Import click
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => {
      checkboxes[0]!.click();
      await new Promise(r => setTimeout(r, 10));
    });
    expect(importBtn.disabled).toBe(false);
    await act(async () => {
      importBtn.click();
      await new Promise(r => setTimeout(r, 10));
    });
    expect(calls).toContain("POST /api/providers/import-url");
    expect(importedName).toBe("local-box");

    await act(async () => { root.unmount(); });
  });

  test("StorageProfileBackupCard shows localized invalidJson and fileTooLarge errors", async () => {
    const tKo: TFn = (key, vars) => interpolate(DICTS.ko[key], vars);
    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{ locale: "ko", setLocale: () => {}, t: tKo }}>
          <StorageProfileBackupCard apiBase="" t={tKo} onRestored={() => {}} />
        </I18nContext.Provider>,
      );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeDefined();

    // Simulate malformed JSON file selection
    const badJsonFile = new File(["{broken"], "bad.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [badJsonFile] });
    await act(async () => {
      input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });
    expect(container.textContent).toContain(DICTS.ko["storageBackup.invalidJson"]);

    // Simulate oversized (>4 MiB) file selection
    const oversizedMockFile = {
      name: "huge.epxbackup.json",
      size: 4 * 1024 * 1024 + 1,
      text: async () => "{}",
    } as unknown as File;
    Object.defineProperty(input, "files", { configurable: true, value: [oversizedMockFile] });
    await act(async () => {
      input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });
    expect(container.textContent).toContain(DICTS.ko["storageBackup.fileTooLarge"]);

    await act(async () => { root.unmount(); });
  });

  test("StorageProfileBackupCard enforces 8+ char passphrase on encrypted export and submits redacted export", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), body: String(init?.body ?? "") });
      return Response.json({
        schema: "epx.profile.backup/1",
        mode: "redacted",
        createdAt: new Date().toISOString(),
        appVersion: "1.0.0",
        summary: { providerCount: 1, oauthAccountCount: 0, codexAccountCount: 0, hasLocalCredentials: false, integrationRecordCount: 0, includedFiles: ["config.json"] },
        payload: { files: { "config.json": {} } },
      });
    }) as unknown as typeof fetch;

    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => {};

    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<I18nWrapper><StorageProfileBackupCard apiBase="" t={tEn} onRestored={() => {}} /></I18nWrapper>);
      });

      const exportBtn = [...container.querySelectorAll("button")].find(b => b.textContent === DICTS.en["storageBackup.exportBtn"]) as HTMLButtonElement;
      // Default mode is encrypted with empty passphrase -> button disabled
      expect(exportBtn.disabled).toBe(true);

      const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="backup-export-mode"]')];
      await act(async () => {
        radios[1]!.click();
      });
      expect(exportBtn.disabled).toBe(false);

      await act(async () => {
        exportBtn.click();
        await new Promise(r => setTimeout(r, 10));
      });
      expect(calls[0]?.url).toBe("/api/profile/backup/export");
      expect(JSON.parse(calls[0]!.body).mode).toBe("redacted");
      expect(container.textContent).toContain(DICTS.en["storageBackup.exportSuccess"]);
      await act(async () => { root.unmount(); });
    } finally {
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });
});
