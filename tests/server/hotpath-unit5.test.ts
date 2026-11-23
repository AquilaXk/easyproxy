import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { rememberTransientOutboundWireBody } from "../../src/lib/transient-outbound-body";
import { parseOutboundRequestBody } from "../../src/server/responses/outbound-request-body";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { concreteComboRequestBody } from "../../src/combos/request";
import { cloneResponsesRequestEnvelope } from "../../src/lib/responses-envelope-copy";
import {
  admitParsedJsonRequestBody,
  attachParsedRequestBody,
  DecompressedBodyTooLargeError,
  takeParsedRequestBody,
} from "../../src/server/request-decompress";
import * as jsonSerializedBytes from "../../src/server/json-serialized-bytes";
import { wasRequestBodyRejected } from "../../src/server/request-body-facts";
import { StatFileCache } from "../../src/lib/stat-file-cache";
import { peekAuthStore, saveCredential } from "../../src/oauth/store";
import { catalogModelSupportsServiceTier, readConfiguredCodexServiceTier } from "../../src/server/request-log-inspection";
import { readCodexCatalogPath } from "../../src/codex/paths";
import {
  addRequestLog,
  clearRequestLogsForTests,
  evictOldestRequestLogForBudget,
  getRequestLogEntries,
  rehydrateRequestLogsAfterLedgerReplacement,
  requestLogRetainedStoreSnapshot,
  type RequestLogEntry,
} from "../../src/server/request-log";
import { MAX_LOG_SIZE } from "../../src/server/request-log-filter";
import { appendUsageEntry, readRecentUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import type { EpxParsedRequest, EpxProviderConfig } from "../../src/types";

let tempRoot: string;
let epxHome: string;
let codexHome: string;
let prevEpxHome: string | undefined;
let prevCodexHome: string | undefined;

beforeEach(() => {
  prevEpxHome = process.env.EASYPROXY_HOME;
  prevCodexHome = process.env.CODEX_HOME;
  tempRoot = mkdtempSync(join(tmpdir(), "epx-hotpath-unit5-"));
  epxHome = join(tempRoot, "epx");
  codexHome = join(tempRoot, "codex");
  mkdirSync(epxHome, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  process.env.EASYPROXY_HOME = epxHome;
  process.env.CODEX_HOME = codexHome;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  if (prevEpxHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = prevEpxHome;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  removeTreeWithRetry(tempRoot);
});

function sampleLogEntry(index: number, model = "gpt-5.6"): RequestLogEntry {
  return {
    requestId: `epx-ring-${index}`,
    timestamp: 1_700_000_000_000 + index,
    provider: "openai",
    model,
    client: "codex-cli",
    status: 200,
    durationMs: 12,
    usageStatus: "reported",
    usage: { inputTokens: 10 + index, outputTokens: 5 },
  };
}

describe("Unit 5 hot-path optimizations", () => {
  test("1. transient outbound wire body avoids post-serialize JSON.parse and handles single-consume & modified fallback", async () => {
    const wireBody: Record<string, unknown> = {
      model: "gpt-5.6",
      tools: [{ type: "function", name: "lookup" }],
      input: [{ role: "user", content: "hi" }],
    };
    const serialized = JSON.stringify(wireBody);
    const reqObj = { url: "https://api.example/v1/responses", method: "POST", headers: {}, body: serialized };
    rememberTransientOutboundWireBody(reqObj, serialized, wireBody);

    const jsonParseSpy = spyOn(JSON, "parse");
    try {
      const first = parseOutboundRequestBody(serialized, reqObj);
      expect(first).toBe(wireBody);
      expect(jsonParseSpy).toHaveBeenCalledTimes(0);

      // Single-consume: second read for same request must fall back to JSON.parse.
      const second = parseOutboundRequestBody(serialized, reqObj);
      expect(second).toEqual(wireBody);
      expect(second).not.toBe(wireBody);
      expect(jsonParseSpy).toHaveBeenCalledTimes(1);

      // Modified-body fallback: mismatch consumes entry and parses modified text.
      rememberTransientOutboundWireBody(reqObj, serialized, wireBody);
      const modified = JSON.stringify({ model: "gpt-5.6-edited", tools: [] });
      const third = parseOutboundRequestBody(modified, reqObj);
      expect(third).toEqual({ model: "gpt-5.6-edited", tools: [] });
      expect(jsonParseSpy).toHaveBeenCalledTimes(2);
      // Consumed even on mismatch, so original text now also misses.
      const fourth = parseOutboundRequestBody(serialized, reqObj);
      expect(fourth).toEqual(wireBody);
      expect(jsonParseSpy).toHaveBeenCalledTimes(3);
    } finally {
      jsonParseSpy.mockRestore();
    }

    // Adapter buildRequest registers transient wireBody automatically.
    const provider: EpxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.example/v1",
      authMode: "key",
      apiKey: "fixture-key",
      models: ["gpt-5.6"],
    };
    const adapter = createResponsesPassthroughAdapter(provider);
    const budget = createTranslatorBudget();
    const rawBody = {
      model: "gpt-5.6",
      input: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", name: "ping", parameters: { type: "object", properties: {} } }],
      stream: true,
    };
    const parsed: EpxParsedRequest = {
      modelId: "gpt-5.6",
      stream: true,
      context: { messages: [{ role: "user", content: "hello" }] },
      options: {},
      _rawBody: rawBody,
    };
    const built = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
    const adapterParseSpy = spyOn(JSON, "parse");
    try {
      const taken = parseOutboundRequestBody(built.body as string, built);
      expect(taken).toBeDefined();
      expect(taken!.model).toBe("gpt-5.6");
      expect(adapterParseSpy).toHaveBeenCalledTimes(0);
    } finally {
      adapterParseSpy.mockRestore();
      built.releaseBodyObservation?.();
    }
  });

  test("2a. targeted envelope copy isolates mutated items while sharing immutable subtrees", () => {
    const tools = [{ type: "function", name: "heavy_schema", parameters: { type: "object", properties: { a: { type: "string" } } } }];
    const ordinaryUserItem = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] };
    const agentMessageItem = {
      type: "agent_message",
      id: "am_1",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAA_payload" }],
    };
    const reasoningEncryptedItem = {
      type: "reasoning",
      encrypted_content: "gAAAA_reason",
      summary: [{ type: "summary_text", text: "step" }],
    };
    const skillsDevItem = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<skills_instructions>v1</skills_instructions>" }],
    };
    const parent = {
      model: "combo/fast",
      instructions: "Follow instructions.",
      metadata: { traceId: "t-1" },
      reasoning: { effort: "medium", summary: "auto" },
      text: { format: { type: "text" } },
      client_metadata: { "x-codex-turn-state": "state-1", session: "s-1" },
      tools,
      input: [ordinaryUserItem, agentMessageItem, reasoningEncryptedItem, skillsDevItem],
    };

    const child = concreteComboRequestBody(
      parent,
      { provider: "openai", model: "gpt-5.6" },
      "high",
      ["low", "medium", "high"],
    );

    // Immutable subtrees stay shared by reference.
    expect(child.tools).toBe(parent.tools);
    expect(child.instructions).toBe(parent.instructions);
    expect(child.metadata).toBe(parent.metadata);
    const childInput = child.input as unknown[];
    expect(childInput).not.toBe(parent.input);
    expect(childInput[0]).toBe(ordinaryUserItem);

    // Mutated envelope & special input items are isolated.
    expect(child.reasoning).not.toBe(parent.reasoning);
    expect(child.text).not.toBe(parent.text);
    expect(child.client_metadata).not.toBe(parent.client_metadata);
    expect(childInput[1]).not.toBe(agentMessageItem);
    expect(childInput[2]).not.toBe(reasoningEncryptedItem);
    expect(childInput[3]).not.toBe(skillsDevItem);

    (child.reasoning as Record<string, unknown>).effort = "low";
    delete (child.client_metadata as Record<string, unknown>)["x-codex-turn-state"];
    (childInput[1] as { content: Array<{ encrypted_content: string }> }).content[0]!.encrypted_content = "mutated";
    (childInput[2] as { encrypted_content: string }).encrypted_content = "mutated";
    (childInput[3] as { content: Array<{ text: string }> }).content[0]!.text = "replaced";

    expect(parent.reasoning.effort).toBe("medium");
    expect(parent.client_metadata["x-codex-turn-state"]).toBe("state-1");
    expect(agentMessageItem.content[0]!.encrypted_content).toBe("gAAAA_payload");
    expect(reasoningEncryptedItem.encrypted_content).toBe("gAAAA_reason");
    expect(skillsDevItem.content[0]!.text).toBe("<skills_instructions>v1</skills_instructions>");

    // Fallback isolation option copies tools wrapper and ordinary item envelopes shallowly.
    const snapshot = cloneResponsesRequestEnvelope(parent, {
      shallowCopyToolsArray: true,
      shallowCopyInputItems: true,
    }) as typeof parent;
    expect(snapshot.tools).not.toBe(parent.tools);
    expect(snapshot.tools[0]).toBe(parent.tools[0]);
    expect(snapshot.input[0]).not.toBe(ordinaryUserItem);
    expect((snapshot.input[0] as typeof ordinaryUserItem).content).toBe(ordinaryUserItem.content);
    const expectedContent = structuredClone(ordinaryUserItem.content);
    (parent.tools as unknown[]).push({ type: "function", name: "extra" });
    (parent.input[0] as { content: unknown }).content = "overwritten";
    expect(snapshot.tools).toHaveLength(1);
    expect((snapshot.input[0] as typeof ordinaryUserItem).content).toEqual(expectedContent);
  });

  test("2b. attachParsedRequestBody threads knownSerializedBytes to skip serializedJsonByteLength and enforces Fail-Closed limit", () => {
    const byteLengthSpy = spyOn(jsonSerializedBytes, "serializedJsonByteLength");
    try {
      const payload = { model: "gpt-5.6", input: [{ role: "user", content: "hello world" }] };
      const exactBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      const req = new Request("http://127.0.0.1/v1/responses", { method: "POST" });
      const budget = createTranslatorBudget();

      attachParsedRequestBody(req, payload, exactBytes);
      const taken = takeParsedRequestBody(req);
      expect(taken).toEqual({ body: payload, knownSerializedBytes: exactBytes });
      expect(takeParsedRequestBody(req)).toBeUndefined();

      const admitted = admitParsedJsonRequestBody(taken!.body, exactBytes, budget, req, taken!.knownSerializedBytes);
      expect(admitted).toBe(payload);
      expect(byteLengthSpy).toHaveBeenCalledTimes(0);

      // Oversizing Fail-Closed rejection when knownSerializedBytes > maxBytes.
      const bigReq = new Request("http://127.0.0.1/v1/responses", { method: "POST" });
      attachParsedRequestBody(bigReq, payload, exactBytes);
      const bigTaken = takeParsedRequestBody(bigReq)!;
      expect(() =>
        admitParsedJsonRequestBody(bigTaken.body, exactBytes - 1, budget, bigReq, bigTaken.knownSerializedBytes),
      ).toThrow(DecompressedBodyTooLargeError);
      expect(wasRequestBodyRejected(bigReq)).toBe(true);
      expect(byteLengthSpy).toHaveBeenCalledTimes(0);

      // Invalid/omitted knownSerializedBytes falls back to serializedJsonByteLength.
      const fallbackReq = new Request("http://127.0.0.1/v1/responses", { method: "POST" });
      attachParsedRequestBody(fallbackReq, payload, -5);
      const fallbackTaken = takeParsedRequestBody(fallbackReq)!;
      expect(fallbackTaken.knownSerializedBytes).toBeUndefined();
      admitParsedJsonRequestBody(fallbackTaken.body, exactBytes, budget, fallbackReq, fallbackTaken.knownSerializedBytes);
      expect(byteLengthSpy).toHaveBeenCalledTimes(1);
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  test("3a. StatFileCache caches by BigIntStats, evicts past cap, invalidates on deletion, and bypasses when fs is spied", async () => {
    let parseCount = 0;
    const cache = new StatFileCache<{ v: number }>(bytes => {
      parseCount += 1;
      return JSON.parse(bytes.toString("utf8")) as { v: number };
    }, 2);

    const fileA = join(tempRoot, "a.json");
    const fileB = join(tempRoot, "b.json");
    const fileC = join(tempRoot, "c.json");
    writeFileSync(fileA, JSON.stringify({ v: 1 }));
    writeFileSync(fileB, JSON.stringify({ v: 2 }));
    writeFileSync(fileC, JSON.stringify({ v: 3 }));

    const firstA = cache.read(fileA);
    const secondA = cache.read(fileA);
    expect(firstA).toEqual({ v: 1 });
    expect(secondA).toBe(firstA);
    expect(parseCount).toBe(1);

    // Modification invalidates cached value.
    writeFileSync(fileA, JSON.stringify({ v: 100 }));
    expect(cache.read(fileA)).toEqual({ v: 100 });
    expect(parseCount).toBe(2);

    // Bounded capacity (maxEntries=2) evicts oldest entry (fileA) when fileB and fileC enter.
    expect(cache.read(fileB)).toEqual({ v: 2 });
    expect(cache.read(fileC)).toEqual({ v: 3 });
    expect(parseCount).toBe(4);
    expect(cache.read(fileA)).toEqual({ v: 100 });
    expect(parseCount).toBe(5);

    // Deletion invalidates cleanly and returns undefined.
    unlinkSync(fileA);
    expect(cache.read(fileA)).toBeUndefined();
    expect(parseCount).toBe(5);

    // Spy guard: spying on readFileSync or statSync bypasses cache.
    const readSpy = spyOn(fs, "readFileSync");
    try {
      expect(cache.read(fileC)).toEqual({ v: 3 });
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(parseCount).toBe(6);
    } finally {
      readSpy.mockRestore();
    }

    const statSpy = spyOn(fs, "statSync");
    try {
      expect(cache.read(fileC)).toEqual({ v: 3 });
      expect(statSpy).toHaveBeenCalledTimes(0);
      expect(parseCount).toBe(7);
    } finally {
      statSpy.mockRestore();
    }

    // Fail-Closed byte cap: normal branch and spy-bypass branch both throw RangeError and drop cached entry.
    let boundedParseCount = 0;
    const boundedCache = new StatFileCache<{ v: number }>(bytes => {
      boundedParseCount += 1;
      return JSON.parse(bytes.toString("utf8")) as { v: number };
    }, 4, 24);
    const boundedFile = join(tempRoot, "bounded.json");
    writeFileSync(boundedFile, JSON.stringify({ v: 1 }));
    expect(boundedCache.read(boundedFile)).toEqual({ v: 1 });
    expect(boundedParseCount).toBe(1);

    // Spy-bypass oversize read drops the previously cached entry even when on-disk stat stays unchanged.
    const oversizeSpy = spyOn(fs, "readFileSync").mockReturnValueOnce(Buffer.alloc(32, 0x20));
    try {
      expect(() => boundedCache.read(boundedFile)).toThrow(RangeError);
      expect(boundedParseCount).toBe(1);
    } finally {
      oversizeSpy.mockRestore();
    }
    expect(boundedCache.read(boundedFile)).toEqual({ v: 1 });
    expect(boundedParseCount).toBe(2);

    // Normal branch oversize read throws RangeError before parsing and evicts prior cache entry.
    writeFileSync(boundedFile, JSON.stringify({ v: 9, pad: "12345678901234567890" }));
    expect(() => boundedCache.read(boundedFile)).toThrow(RangeError);
    expect(boundedParseCount).toBe(2);
    writeFileSync(boundedFile, JSON.stringify({ v: 2 }));
    expect(boundedCache.read(boundedFile)).toEqual({ v: 2 });
    expect(boundedParseCount).toBe(3);

    // peekAuthStore caches reads and invalidates on persist.
    expect(peekAuthStore()).toEqual({});
    await saveCredential("anthropic", {
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 60_000,
      accountId: "acct-1",
      email: "a@example.test",
    });
    const peek1 = peekAuthStore();
    const peek2 = peekAuthStore();
    expect(peek2).toBe(peek1);
    expect(peek1.anthropic?.accounts[0]?.credential.access).toBe("access-1");

    await saveCredential("anthropic", {
      access: "access-2",
      refresh: "refresh-2",
      expires: Date.now() + 60_000,
      accountId: "acct-1",
      email: "a@example.test",
    });
    const peek3 = peekAuthStore();
    expect(peek3).not.toBe(peek1);
    expect(peek3.anthropic?.accounts[0]?.credential.access).toBe("access-2");
  });

  test("3b. request-log-inspection and readCodexCatalogPath cache TOML/catalog reads and index models O(1)", () => {
    const customCatalog = join(codexHome, "custom-catalog.json");
    writeFileSync(
      join(codexHome, "config.toml"),
      `service_tier = "fast"\nmodel_catalog_json = "custom-catalog.json"\n`,
    );
    writeFileSync(
      customCatalog,
      JSON.stringify({
        models: [
          { slug: "gpt-5.6", id: "gpt-5.6-id", service_tiers: [{ id: "priority" }] },
          { slug: "gpt-5.6-id", service_tiers: [] },
          { slug: "gpt-standard", service_tiers: [] },
        ],
      }),
    );

    const jsonSpy = spyOn(JSON, "parse");
    const tomlSpy = spyOn(Bun.TOML, "parse");
    try {
      expect(readCodexCatalogPath()).toBe(realpathSync.native(customCatalog));
      expect(readConfiguredCodexServiceTier()).toBe("fast");
      expect(catalogModelSupportsServiceTier("gpt-5.6", "fast")).toBe(true);
      expect(catalogModelSupportsServiceTier("gpt-5.6-id", "priority")).toBe(true);
      expect(catalogModelSupportsServiceTier("gpt-standard", "fast")).toBe(false);
      expect(catalogModelSupportsServiceTier("unknown-model", "fast")).toBeUndefined();
      expect(readCodexCatalogPath()).toBe(realpathSync.native(customCatalog));
      expect(readConfiguredCodexServiceTier()).toBe("fast");

      // Only one JSON.parse for the catalog and one TOML parse pass per file across all repeated reads.
      expect(jsonSpy).toHaveBeenCalledTimes(1);
      const tomlCallsAfterWarm = tomlSpy.mock.calls.length;
      expect(tomlCallsAfterWarm).toBe(7);
      expect(readConfiguredCodexServiceTier()).toBe("fast");
      expect(catalogModelSupportsServiceTier("gpt-5.6", "fast")).toBe(true);
      expect(tomlSpy).toHaveBeenCalledTimes(tomlCallsAfterWarm);

      // Update catalog on disk -> cache invalidates and re-parses once.
      writeFileSync(
        customCatalog,
        JSON.stringify({
          models: [{ slug: "gpt-standard", service_tiers: [{ id: "priority" }] }],
        }),
      );
      expect(catalogModelSupportsServiceTier("gpt-standard", "fast")).toBe(true);
      expect(catalogModelSupportsServiceTier("gpt-5.6", "fast")).toBeUndefined();
      expect(jsonSpy).toHaveBeenCalledTimes(2);
    } finally {
      jsonSpy.mockRestore();
      tomlSpy.mockRestore();
    }
  });

  test("4. request-log ring buffer preserves FIFO order, accurate serializedJsonByteLength accounting, and budget eviction", () => {
    const total = MAX_LOG_SIZE + 5;
    for (let i = 0; i < total; i += 1) {
      addRequestLog(sampleLogEntry(i, i % 2 === 0 ? "gpt-5.6-한글" : "gpt-5.6"));
    }

    const entries = getRequestLogEntries();
    expect(entries).toHaveLength(MAX_LOG_SIZE);
    expect(entries[0]!.requestId).toBe("epx-ring-5");
    expect(entries[entries.length - 1]!.requestId).toBe(`epx-ring-${total - 1}`);

    // Mutating returned array must not corrupt ring buffer state.
    entries.pop();
    expect(getRequestLogEntries()).toHaveLength(MAX_LOG_SIZE);

    const expectedBytes = getRequestLogEntries().reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row), "utf8"),
      0,
    );
    const snap = requestLogRetainedStoreSnapshot();
    expect(snap.count).toBe(MAX_LOG_SIZE);
    expect(snap.bytes).toBe(expectedBytes);
    expect(snap.oldestAt).toBe(1_700_000_000_005);

    const oldestExpectedBytes = Buffer.byteLength(JSON.stringify(getRequestLogEntries()[0]), "utf8");
    const evicted = evictOldestRequestLogForBudget();
    expect(evicted).toBeGreaterThan(0);
    expect(evicted).toBe(oldestExpectedBytes);
    const afterEvict = requestLogRetainedStoreSnapshot();
    expect(afterEvict.count).toBe(MAX_LOG_SIZE - 1);
    expect(afterEvict.bytes).toBe(expectedBytes - evicted);
    expect(afterEvict.oldestAt).toBe(1_700_000_000_006);

    // Rehydration resets and refills cleanly.
    const hydrated = rehydrateRequestLogsAfterLedgerReplacement(() => [
      {
        requestId: "epx-rehydrated-1",
        timestamp: 1_700_000_999_000,
        provider: "openai",
        model: "gpt-5.6",
        status: 200,
        durationMs: 5,
        usageStatus: "unreported",
      },
    ]);
    expect(hydrated).toBe(1);
    expect(getRequestLogEntries().map(row => row.requestId)).toEqual(["epx-rehydrated-1"]);
  });

  test("5. usage log skips redundant mkdirSync/chmodSync on expired checks when modes are intact and re-narrows widened modes", () => {
    let now = 1_700_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const mkdirSpy = spyOn(fs, "mkdirSync");
    const chmodSpy = spyOn(fs, "chmodSync");
    try {
      const logEntry = (id: string) => ({
        requestId: id,
        timestamp: now,
        provider: "openai",
        model: "gpt-5.6",
        status: 200,
        durationMs: 10,
        usageStatus: "unreported" as const,
      });

      // Call 1: initial dir + file setup runs 1 mkdirSync and 2 chmodSync.
      appendUsageEntry(logEntry("u-1"));
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).toHaveBeenCalledTimes(2);

      // Call 2 within 1s window: skips stat/mkdir/chmod.
      now += 500;
      appendUsageEntry(logEntry("u-2"));
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).toHaveBeenCalledTimes(2);

      // Call 3 after 1s window with intact 0700/0600 modes: zero mkdirSync and zero extra chmodSync.
      now += 1_000;
      appendUsageEntry(logEntry("u-3"));
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).toHaveBeenCalledTimes(2);

      if (process.platform !== "win32") {
        // Widen permissions externally -> Call 4 after 1s window re-narrows both.
        const logPath = join(epxHome, "usage.jsonl");
        chmodSync(epxHome, 0o755);
        chmodSync(logPath, 0o644);
        chmodSpy.mockClear();
        mkdirSpy.mockClear();

        now += 1_000;
        appendUsageEntry(logEntry("u-4"));
        expect(mkdirSpy).toHaveBeenCalledTimes(0);
        expect(chmodSpy).toHaveBeenCalledTimes(2);
        expect(statSync(epxHome).mode & 0o777).toBe(0o700);
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      }

      // Directory deleted between expired checks -> ENOENT in statSync recovers cleanly.
      rmSync(epxHome, { recursive: true, force: true });
      now += 1_000;
      appendUsageEntry(logEntry("u-5"));
      expect(readRecentUsageEntries(10).map(row => row.requestId)).toEqual(["u-5"]);
    } finally {
      clock.mockRestore();
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });
});
