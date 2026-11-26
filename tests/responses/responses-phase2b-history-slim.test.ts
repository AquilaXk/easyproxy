import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { setCodexWsIncrementalUpload } from "../../src/config/codex-ws-incremental-setting";
import {
  bindUpstreamHistorySlimConfig,
  historySlimDigestBookStats,
  HISTORY_SLIM_LONG_TTL_MS,
  HISTORY_SLIM_SHORT_TTL_MS,
  resetHistorySlimDigestBookForTest,
  slimCodexHistoryJson,
  slimOutboundCodexHistory,
} from "../../src/server/responses/history-slim";
import type { EpxParsedRequest } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

function user(text: string, extra: unknown[] = []): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }, ...extra] };
}

function img(bytes: number): Record<string, unknown> {
  return { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(bytes)}` };
}

function fnOut(callId: string, output: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "function_call_output", call_id: callId, output, ...extra };
}

afterEach(() => {
  setCodexWsIncrementalUpload(false);
  bindUpstreamHistorySlimConfig(null);
  resetHistorySlimDigestBookForTest();
});

describe("Phase 2-B buildRoutedCompactionBody tool-output deduplication", () => {
  test("deduplicates >= 2 KiB non-error function_call_output with reference stub and skips errors / small outputs", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "sk-test",
    });

    const dupPayload = "export const line = 1;\n".repeat(120); // > 2 KiB
    const errPayload = `Exit code 1\n${"fatal stack frame\n".repeat(150)}`; // > 2 KiB but error!
    const smallPayload = "short ok output"; // < 2 KiB

    const rawBody = {
      model: "gpt-5.4",
      input: [
        user("inspect files"),
        fnOut("call_dup_1", dupPayload),
        fnOut("call_dup_2", dupPayload),
        fnOut("call_err_1", errPayload),
        fnOut("call_err_2", errPayload),
        fnOut("call_flag_1", dupPayload, { is_error: true }),
        fnOut("call_small_1", smallPayload),
        fnOut("call_small_2", smallPayload),
      ],
    };

    const parsed: EpxParsedRequest = {
      modelId: "gpt-5.4",
      stream: false,
      options: {},
      context: { messages: [] },
      _compactionRequest: true,
      _portableCompaction: true,
      _rawBody: rawBody,
    };

    const built = adapter.buildRequest(parsed, {
      headers: new Headers(),
      providerName: "gw",
      translatorBudget: createTestTranslatorBudget(),
    });
    const wire = JSON.parse(built.body) as { input: Array<Record<string, unknown>> };
    const byCallId = new Map(
      wire.input
        .filter(item => typeof item.call_id === "string")
        .map(item => [item.call_id as string, item]),
    );

    expect(byCallId.get("call_dup_1")!.output).toBe(dupPayload);
    expect(byCallId.get("call_dup_2")!.output).toBe("[identical tool output omitted; see earlier call_id=call_dup_1]");
    expect(byCallId.get("call_err_1")!.output).toBe(errPayload);
    expect(byCallId.get("call_err_2")!.output).toBe(errPayload);
    expect(byCallId.get("call_flag_1")!.output).toBe(dupPayload);
    expect(byCallId.get("call_small_1")!.output).toBe(smallPayload);
    expect(byCallId.get("call_small_2")!.output).toBe(smallPayload);
  });
});

describe("Phase 2-B cache-lifetime digest book in history-slim", () => {
  test("freezes slim/dedup boundary while cache is warm (5m TTL) and advances only on cold expiry", () => {
    setCodexWsIncrementalUpload(false);
    bindUpstreamHistorySlimConfig({ upstreamHistorySlim: "codex" });
    const headers = { session_id: "sess-alpha" };
    const dupOutput = "line of repository output\n".repeat(120); // > 2 KiB
    const t0 = 1_700_000_000_000;

    // Turn 1 (cold): lastUser = 0, so nothing before user_0 is slimmed.
    const turn1 = [user("start", [img(4096)]), fnOut("call_1", dupOutput)];
    const out1 = slimOutboundCodexHistory(CODEX_URL, { headers, body: JSON.stringify({ input: turn1 }) }, { now: t0 });
    expect(out1?.body).toBe(JSON.stringify({ input: turn1 }));

    // Turn 2 (30s later -> WARM!): client adds identical tool output + user_1.
    // Even though lastUser is now 3, boundary MUST remain frozen at 0 to preserve Turn 1's cache!
    const turn2 = [...turn1, fnOut("call_2", dupOutput), user("next question")];
    const out2 = slimOutboundCodexHistory(
      CODEX_URL,
      { headers, body: JSON.stringify({ input: turn2 }) },
      { now: t0 + 30_000 },
    );
    expect(out2?.body).toBe(JSON.stringify({ input: turn2 }));

    // Turn 3 (still within 5m TTL): prefix stays warm and frozen at boundary 0.
    const turn3 = [...turn2, fnOut("call_3", "third output".repeat(300)), user("follow up")];
    const out3 = slimOutboundCodexHistory(
      CODEX_URL,
      { headers, body: JSON.stringify({ input: turn3 }) },
      { now: t0 + 120_000 },
    );
    expect(out3?.body).toBe(JSON.stringify({ input: turn3 }));

    // Turn 4 (beyond 5m TTL -> COLD!): boundary advances up to latest user_3 (index 5)!
    const turn4Cold = [...turn3];
    const out4 = slimOutboundCodexHistory(
      CODEX_URL,
      { headers, body: JSON.stringify({ input: turn4Cold }) },
      { now: t0 + 120_000 + HISTORY_SLIM_SHORT_TTL_MS + 1_000 },
    );
    expect(out4).toBeDefined();
    expect(out4?.body).not.toBe(JSON.stringify({ input: turn4Cold }));
    const parsed4 = JSON.parse(String(out4?.body)) as { input: Array<Record<string, unknown>> };
    expect(JSON.stringify(parsed4.input[0])).not.toContain("data:image");
    expect(parsed4.input[1]!.output).toBe(dupOutput);
    expect(parsed4.input[2]!.output).toBe("[identical tool output omitted; see earlier call_id=call_1]");

    // Turn 5 (30s after Turn 4 -> WARM on new boundary 5!):
    // Prefix 0..4 matches slimmed Turn 4 identically, new turn5 output >= index 5 stays raw!
    const turn5Warm = [...turn4Cold, fnOut("call_4", dupOutput), user("after cold")];
    const out5 = slimOutboundCodexHistory(
      CODEX_URL,
      { headers, body: JSON.stringify({ input: turn5Warm }) },
      { now: t0 + 120_000 + HISTORY_SLIM_SHORT_TTL_MS + 31_000 },
    );
    const parsed5 = JSON.parse(String(out5?.body)) as { input: Array<Record<string, unknown>> };
    expect(parsed5.input[2]!.output).toBe("[identical tool output omitted; see earlier call_id=call_1]");
    // Index 6 (added after Turn 4's cached boundary 5) is NOT prematurely slimmed while Turn 4's cache is warm!
    expect(parsed5.input[6]!.output).toBe(dupOutput);
  });

  test("honors 1-hour cache TTL via prompt_cache_retention=1h / extended-cache-ttl / cacheRetention=long", () => {
    setCodexWsIncrementalUpload(false);
    bindUpstreamHistorySlimConfig({ upstreamHistorySlim: "codex" });
    const dupOutput = "long retention cache payload\n".repeat(120);
    const t0 = 1_700_000_000_000;

    const turn1 = [user("begin", [img(4096)]), fnOut("c1", dupOutput)];
    slimOutboundCodexHistory(
      CODEX_URL,
      { body: JSON.stringify({ prompt_cache_key: "pck-1h", prompt_cache_retention: "1h", input: turn1 }) },
      { now: t0 },
    );

    // 20 minutes later (>5m, <1h): still WARM, keeps prefix intact!
    const turn2 = [...turn1, fnOut("c2", dupOutput), user("step 2")];
    const warm20m = slimOutboundCodexHistory(
      CODEX_URL,
      { body: JSON.stringify({ prompt_cache_key: "pck-1h", prompt_cache_retention: "1h", input: turn2 }) },
      { now: t0 + 20 * 60_000 },
    );
    expect(warm20m?.body).toBe(JSON.stringify({ prompt_cache_key: "pck-1h", prompt_cache_retention: "1h", input: turn2 }));

    // 61 minutes later after turn2 (>1h): COLD, compacts & deduplicates!
    const cold61m = slimOutboundCodexHistory(
      CODEX_URL,
      { body: JSON.stringify({ prompt_cache_key: "pck-1h", prompt_cache_retention: "1h", input: turn2 }) },
      { now: t0 + 20 * 60_000 + HISTORY_SLIM_LONG_TTL_MS + 1_000 },
    );
    const parsedCold = JSON.parse(String(cold61m?.body)) as { input: Array<Record<string, unknown>> };
    expect(JSON.stringify(parsedCold.input[0])).not.toContain("data:image");
    expect(parsedCold.input[2]!.output).toBe("[identical tool output omitted; see earlier call_id=c1]");
  });

  test("bypasses stateless cache digest book when codexWsIncrementalUpload is active", () => {
    setCodexWsIncrementalUpload(true);
    bindUpstreamHistorySlimConfig({ upstreamHistorySlim: "codex" });
    const headers = { session_id: "ws-active" };
    const t0 = 1_700_000_000_000;
    const turn1 = [user("hi", [img(4096)])];
    slimOutboundCodexHistory(CODEX_URL, { headers, body: JSON.stringify({ input: turn1 }) }, { now: t0 });
    expect(historySlimDigestBookStats().entries).toBe(0);

    const turn2 = [...turn1, user("next")];
    const out = slimOutboundCodexHistory(CODEX_URL, { headers, body: JSON.stringify({ input: turn2 }) }, { now: t0 + 1_000 });
    expect(String(out?.body)).not.toContain("data:image");
    expect(historySlimDigestBookStats().entries).toBe(0);
  });

  test("stateless slimCodexHistoryJson deduplicates >= 2 KiB non-error tool outputs and bounds digest book", () => {
    const dup = "stateless identical payload\n".repeat(120);
    const body = JSON.stringify({
      input: [user("u1"), fnOut("c1", dup), fnOut("c2", dup), user("u2")],
    });
    const slimmed = slimCodexHistoryJson(body);
    expect(slimmed).toBeString();
    const parsed = JSON.parse(slimmed!) as { input: Array<Record<string, unknown>> };
    expect(parsed.input[2]!.output).toBe("[identical tool output omitted; see earlier call_id=c1]");
    expect(slimCodexHistoryJson(slimmed!)).toBeNull();

    setCodexWsIncrementalUpload(false);
    bindUpstreamHistorySlimConfig({ upstreamHistorySlim: "codex" });
    const sample = JSON.stringify({ input: [user("only")] });
    for (let i = 0; i < 1_100; i += 1) {
      slimOutboundCodexHistory(CODEX_URL, { headers: { session_id: `churn-${i}` }, body: sample }, { now: 1_700_000_000_000 + i });
    }
    const stats = historySlimDigestBookStats();
    expect(stats.entries).toBeLessThanOrEqual(1024);
    expect(stats.bytes).toBeLessThanOrEqual(256 * 1024);
  });
});
