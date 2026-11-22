import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  handleAnthropicResetGrantRoutes,
  type AnthropicResetGrantRouteDeps,
} from "../../src/server/management/anthropic-reset-grant-routes";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import type { ManagementContext } from "../../src/server/management/context";
import { handleGrokCouponRoutes } from "../../src/server/management/grok-coupon-routes";
import type { EpxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;

beforeEach(() => {
  home = createTempHome("epx-mgmt-body-bounds-");
});

afterEach(() => {
  home.remove();
});

function managementConfig(): EpxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
  } as unknown as EpxConfig;
}

function makeContext(
  req: Request,
  url: URL,
  overrides: Partial<ManagementContext> = {},
): ManagementContext {
  return {
    req,
    url,
    config: managementConfig(),
    deps: {},
    version: "test",
    principal: "gui-session",
    trustedLoopbackIngress: true,
    guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({
      status: "ok",
      reason: "none",
      phase: "commit",
      retryable: false,
      partialWrite: false,
    }),
    syncClaudeAgentDefsBestEffort: async () => {},
    ...overrides,
  };
}

function createChunkedByteStream(totalChunks: number, chunkBytes: number): {
  stream: ReadableStream<Uint8Array>;
  chunksEmitted: () => number;
  cancelled: () => boolean;
} {
  const reusableChunk = new Uint8Array(chunkBytes).fill(0x20);
  let emitted = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalChunks) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(reusableChunk);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return {
    stream,
    chunksEmitted: () => emitted,
    cancelled: () => wasCancelled,
  };
}

function deeplyNestedJson(depth: number): string {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

describe("POST /api/grok/reset-coupons/consume body bounds", () => {
  const endpoint = "http://127.0.0.1:10100/api/grok/reset-coupons/consume";

  test("rejects JSON null body with 400", async () => {
    const url = new URL(endpoint);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const res = await handleGrokCouponRoutes(makeContext(req, url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: { code: "invalid_json" } });
  });

  test("rejects non-string accountId with 400", async () => {
    const url = new URL(endpoint);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: 123 }),
    });
    const res = await handleGrokCouponRoutes(makeContext(req, url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: { code: "invalid_account_id" } });
  });

  test("rejects > 4 MiB body with 413 without buffering full oversized stream", async () => {
    const url = new URL(endpoint);
    // 64 KiB * 65 = 4 MiB + 64 KiB, exceeding MANAGEMENT_JSON_BODY_MAX_BYTES on chunk 65.
    const source = createChunkedByteStream(80, 64 * 1024);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: source.stream,
    });
    const res = await handleGrokCouponRoutes(makeContext(req, url));
    await Promise.resolve();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
    expect(source.chunksEmitted()).toBe(65);
    expect(source.cancelled()).toBe(true);
  });

  test("rejects JSON nested > 256 levels with 400", async () => {
    const url = new URL(endpoint);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: deeplyNestedJson(257),
    });
    const res = await handleGrokCouponRoutes(makeContext(req, url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("POST /api/anthropic/reset-grants/consume body bounds", () => {
  const endpoint = "http://127.0.0.1:10100/api/anthropic/reset-grants/consume";
  const deps: AnthropicResetGrantRouteDeps = {
    listAccountIds: () => ["acct-1"],
    activeAccountId: () => "acct-1",
    accessTokenFor: async () => {
      throw new Error("accessTokenFor must not be called for rejected bodies");
    },
  };

  test("rejects > 4 MiB body with 413 when dashboard session is valid", async () => {
    const url = new URL(endpoint);
    const source = createChunkedByteStream(80, 64 * 1024);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: source.stream,
    });
    const res = await handleAnthropicResetGrantRoutes(
      makeContext(req, url, { principal: "gui-session", guiSessionIssuance: null }),
      deps,
    );
    await Promise.resolve();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
    expect(source.chunksEmitted()).toBe(65);
    expect(source.cancelled()).toBe(true);
  });

  test("rejects JSON nested > 256 levels with 400 when dashboard session is valid", async () => {
    const url = new URL(endpoint);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: deeplyNestedJson(257),
    });
    const res = await handleAnthropicResetGrantRoutes(
      makeContext(req, url, { principal: "gui-session", guiSessionIssuance: null }),
      deps,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("handleManagementAPI Content-Length preflight bounds", () => {
  const twoAndHalfMiB = 2.5 * 1024 * 1024;

  test("admits Content-Length of 2.5 MiB (> 2 MiB, <= 4 MiB) past preflight into routing", async () => {
    const probeUrl = new URL("http://127.0.0.1:10100/api/nonexistent-bounds-probe");
    const probeReq = new Request(probeUrl, {
      method: "POST",
      headers: {
        Host: "127.0.0.1:10100",
        "Content-Length": String(twoAndHalfMiB),
      },
    });
    expect(probeReq.headers.get("content-length")).toBe(String(twoAndHalfMiB));
    const probeRes = await handleManagementAPI(probeReq, probeUrl, managementConfig(), {}, "gui-session");
    expect(probeRes).toBeNull();

    // Also verify a 2.5 MiB payload reaches the grok coupon route handler instead of failing preflight with 413.
    const prefix = '{"accountId":123,"pad":"';
    const suffix = '"}';
    const padLength = twoAndHalfMiB - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const body = `${prefix}${"a".repeat(padLength)}${suffix}`;
    expect(Buffer.byteLength(body)).toBe(twoAndHalfMiB);

    const routeUrl = new URL("http://127.0.0.1:10100/api/grok/reset-coupons/consume");
    const routeReq = new Request(routeUrl, {
      method: "POST",
      headers: {
        Host: "127.0.0.1:10100",
        "Content-Type": "application/json",
        "Content-Length": String(twoAndHalfMiB),
      },
      body,
    });
    const routeRes = await handleManagementAPI(routeReq, routeUrl, managementConfig(), {}, "gui-session");
    expect(routeRes).not.toBeNull();
    expect(routeRes!.status).toBe(400);
    expect(await routeRes!.json()).toMatchObject({ error: { code: "invalid_account_id" } });
  });

  test("rejects Content-Length > 4 MiB with 413 at preflight", async () => {
    for (const method of ["POST", "PUT", "PATCH"] as const) {
      const url = new URL("http://127.0.0.1:10100/api/nonexistent-bounds-probe");
      const req = new Request(url, {
        method,
        headers: {
          Host: "127.0.0.1:10100",
          "Content-Length": String(MANAGEMENT_JSON_BODY_MAX_BYTES + 1),
        },
      });
      const res = await handleManagementAPI(req, url, managementConfig(), {}, "gui-session");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(413);
      expect(await res!.json()).toEqual({ error: "request body too large" });
    }
  });
});
