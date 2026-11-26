/**
 * Synthetic protocol payload fixtures for read-only guardrail compression
 * and scenario-routing dry-run previews.
 */

export const SAMPLE_PRETTY_JSON = JSON.stringify(
  {
    tool: "mcp_workspace_index",
    files: Array.from({ length: 18 }, (_, i) => ({
      path: `src/modules/service-${i + 1}/handler.ts`,
      symbols: ["handleRequest", "validateInput", "serializeResponse"],
      lines: 180 + i * 12,
      diagnostics: [],
    })),
  },
  null,
  2,
);

export const SAMPLE_ANSI_LOG = [
  "\x1b[32m[build]\x1b[0m compiling workspace crates...",
  "downloading cache\r25%\r60%\r100%",
  ...Array.from(
    { length: 60 },
    (_, i) => `\x1b[36minfo\x1b[0m step ${i + 1}: verified bundle chunk_${i + 1}.mjs (ok)`,
  ),
  "\n\n\n\n\x1b[32m✓ build completed in 1.42s\x1b[0m",
].join("\n");

export const SAMPLE_REPETITIVE_BUILD_LOG = [
  "[cargo] resolving workspace dependencies...",
  ...Array.from({ length: 18 }, (_, i) => `Downloading artifacts (${i + 1}/18) ${Math.round(((i + 1) / 18) * 100)}%`),
  ...Array.from({ length: 12 }, () => "  [cache] layer sha256:9f86d081884c7d659a2feaa0c55ad015 up-to-date"),
  "Finished `release` profile [optimized] target(s) in 3.84s",
].join("\n");

export const SAMPLE_ANTHROPIC_CACHE_PAYLOAD = JSON.stringify(
  {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: `${"You are an architecture review assistant enforcing strict distributed systems invariants. ".repeat(36)}\nCurrent time: 2026-11-27T03:30:45.128Z`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "read_workspace_file",
        description: "Read bounded UTF-8 file slices from the repository workspace. ".repeat(18),
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } },
          required: ["path"],
        },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        name: "mcp__github__search_code",
        description: "Search indexed symbols and pull requests via MCP server. ".repeat(22),
        input_schema: {
          type: "object",
          properties: { query: { type: "string" }, repo: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Audit src/router.ts and src/routing/scenario.ts for cache-preserving effort routing." }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking routeModelInternal and scenarioCfg.efforts propagation...".repeat(8) },
          { type: "tool_use", id: "toolu_01A", name: "read_workspace_file", input: { path: "src/router.ts", startLine: 485, endLine: 540 } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01A",
            content: "export function routeModelInternal(...) {\n  // Bounded zero-allocation scenario classification\n}\n".repeat(28),
          },
        ],
      },
    ],
  },
  null,
  2,
);

export const SAMPLE_OPENAI_RESPONSES_PAYLOAD = JSON.stringify(
  {
    model: "gpt-5.4",
    prompt_cache_key: "epx-session-review-01",
    prompt_cache_retention: "24h",
    instructions: "You are a senior compiler engineer reviewing gateway protocol invariants. ".repeat(38),
    tools: [
      {
        type: "function",
        name: "run_test_shard",
        description: "Execute deterministic unit test shards in an isolated workspace. ".repeat(16),
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" }, isolate: { type: "boolean" } },
          required: ["pattern"],
        },
      },
      {
        type: "mcp",
        server_label: "workspace-index",
        description: "Query symbol references and module boundaries across packages. ".repeat(16),
      },
    ],
    input: [
      { role: "user", content: "Verify scenario effort overrides preserve prompt cache prefixes." },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Inspecting supportedLadderFor and resolveCappedEffort...".repeat(6) }] },
      { type: "function_call", call_id: "call_01", name: "run_test_shard", arguments: "{\"pattern\":\"tests/server/\",\"isolate\":true}" },
      { type: "function_call_output", call_id: "call_01", output: "PASS tests/server/token-efficiency-guardrails-and-cache.test.ts (14 assertions)\n".repeat(22) },
      { role: "user", content: "Summarize any remaining edge cases." },
    ],
  },
  null,
  2,
);

export const SCENARIO_PROBE_SAMPLES: Record<"background" | "think" | "webSearch", string> = {
  background: JSON.stringify(
    {
      system: "Summarize this conversation in 5-10 words.",
      messages: [{ role: "user", content: "Check deployment status for api-gateway." }],
    },
    null,
    2,
  ),
  think: JSON.stringify(
    {
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Verify deadlock freedom in the two-phase commit state machine." }],
    },
    null,
    2,
  ),
  webSearch: JSON.stringify(
    {
      tools: [{ type: "web_search_preview" }],
      messages: [{ role: "user", content: "Latest Anthropic prompt caching documentation updates" }],
    },
    null,
    2,
  ),
};
