import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import type { EpxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousEasyproxyHome = process.env.EASYPROXY_HOME;
let easyproxyHome: string;

function deepSeekConfig(): EpxConfig {
  return {
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.deepseek.com",
        apiKey: "deepseek-secret",
      },
    },
  } as EpxConfig;
}

/** Answer the DeepSeek balance probe with exactly these `balance_infos` rows. */
async function balanceLabel(rows: unknown[]): Promise<string | undefined> {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: rows,
  }), { status: 200 })) as typeof fetch;

  const result = await fetchProviderQuotaReports(deepSeekConfig(), true);

  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]?.source).toBe("deepseek:balance");
  return result.reports[0]?.quota.customWindows?.[0]?.label;
}

beforeEach(() => {
  easyproxyHome = mkdtempSync(join(tmpdir(), "epx-deepseek-quota-"));
  process.env.EASYPROXY_HOME = easyproxyHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousEasyproxyHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousEasyproxyHome;
  removeTreeWithRetry(easyproxyHome);
});

describe("DeepSeek quota balance currency", () => {
  test("a CNY-only row renders the yuan sign", async () => {
    expect(await balanceLabel([{ currency: "CNY", total_balance: "76.88" }]))
      .toBe("API balance (¥76.88)");
  });

  test("a CNY row with a granted balance renders both amounts in yuan", async () => {
    expect(await balanceLabel([{ currency: "CNY", total_balance: "76.88", granted_balance: "12.5" }]))
      .toBe("API balance (¥76.88 total, ¥12.50 granted)");
  });

  test("a USD row keeps the dollar sign", async () => {
    expect(await balanceLabel([{ currency: "USD", total_balance: "6" }]))
      .toBe("API balance ($6.00)");
  });

  test("any other currency prefixes the upper-cased code", async () => {
    expect(await balanceLabel([{ currency: "eur", total_balance: "5" }]))
      .toBe("API balance (EUR 5.00)");
  });

  test("a row without a currency keeps the legacy dollar sign", async () => {
    expect(await balanceLabel([{ total_balance: "5" }]))
      .toBe("API balance ($5.00)");
  });

  test("a USD row is still preferred over a CNY row", async () => {
    expect(await balanceLabel([{ currency: "CNY", total_balance: "10" }, { currency: "USD", total_balance: "7" }]))
      .toBe("API balance ($7.00)");
  });
});
