import http2 from "node:http2";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorH2SessionPool } from "../../src/adapters/cursor/h2-pool";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { getDefaultConfig } from "../../src/config";
import { resolvePublicAddresses } from "../../src/lib/destination-policy";
import { setBespokeProbeAddressResolverForTests } from "../../src/lib/provider-outbound";
import { handleManagementAPI } from "../../src/server/management-api";
import type { EpxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function configWithProvider(name: string, provider: EpxConfig["providers"][string]): EpxConfig {
  return {
    ...getDefaultConfig(),
    providers: {
      [name]: provider,
    },
  };
}

describe("bespoke provider probe SSRF enforcement", () => {
  const homes: string[] = [];
  const origEasyproxyHome = process.env.EASYPROXY_HOME;
  const origFetch = globalThis.fetch;

  afterEach(() => {
    setBespokeProbeAddressResolverForTests(null);
    globalThis.fetch = origFetch;
    if (origEasyproxyHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origEasyproxyHome;
    clearModelCache("ssrf-cursor-probe");
    clearModelCache("ssrf-devin-probe");
    while (homes.length > 0) removeTreeWithRetry(homes.pop()!);
  });

  test("POST /api/providers/test blocks loopback and metadata URLs for custom cursor and devin without dialing", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-probe-ssrf-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not be called for blocked probe destination");
    }) as unknown as typeof globalThis.fetch;

    let localH2Hits = 0;
    const localServer = http2.createServer();
    localServer.on("stream", stream => {
      localH2Hits += 1;
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await new Promise<void>((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = localServer.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind local h2 port");

    const blockedUrls = [
      `http://127.0.0.1:${addr.port}`,
      `https://127.0.0.1:${addr.port}`,
      "https://169.254.169.254",
    ];

    try {
      for (const adapter of ["cursor", "devin"] as const) {
        for (const baseUrl of blockedUrls) {
          const providerName = `ssrf-${adapter}-probe`;
          const cfg = configWithProvider(providerName, {
            adapter,
            authMode: "key",
            baseUrl,
            apiKey: "test-probe-token",
            models: [],
          });
          const reqUrl = new URL(`http://127.0.0.1/api/providers/test?name=${encodeURIComponent(providerName)}`);
          const res = await handleManagementAPI(
            new ManagementRequest(reqUrl, { method: "POST" }),
            reqUrl,
            cfg,
          );
          expect(res?.status).toBe(200);
          const body = await res!.json() as { ok: boolean; error?: string };
          expect(body.ok).toBe(false);
          expect(body.error).toMatch(/metadata|private|loopback|allowPrivateNetwork/i);
        }
      }
      expect(fetchCalls).toBe(0);
      expect(localH2Hits).toBe(0);
    } finally {
      await new Promise<void>(resolve => localServer.close(() => resolve()));
    }
  });

  test("gatherRoutedModels skips live discovery for loopback cursor and devin rows without allowPrivateNetwork", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-catalog-ssrf-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not be called for blocked catalog destination");
    }) as unknown as typeof globalThis.fetch;

    const models = await gatherRoutedModels({
      providers: {
        "ssrf-cursor-probe": {
          adapter: "cursor",
          baseUrl: "http://127.0.0.1:9999",
          apiKey: "test-token",
          models: ["auto"],
        },
        "ssrf-devin-probe": {
          adapter: "devin",
          baseUrl: "http://127.0.0.1:9999",
          apiKey: "test-token",
          models: ["swe-1-7"],
        },
      },
    });

    expect(models.some(m => m.provider === "ssrf-cursor-probe" && m.id === "auto")).toBe(true);
    expect(models.some(m => m.provider === "ssrf-devin-probe" && m.id === "swe-1-7")).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("DNS answers resolving to loopback or metadata block both /api/providers/test and gatherRoutedModels", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-dns-ssrf-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not be called when DNS resolves to private/metadata IPs");
    }) as unknown as typeof globalThis.fetch;

    for (const resolvedIp of ["127.0.0.1", "169.254.169.254"]) {
      let dnsLookups = 0;
      setBespokeProbeAddressResolverForTests(async (_url, opts) => {
        dnsLookups += 1;
        return resolvePublicAddresses(`https://${resolvedIp}`, opts);
      });

      for (const adapter of ["cursor", "devin"] as const) {
        const providerName = `ssrf-${adapter}-probe`;
        clearModelCache(providerName);
        const provider = {
          adapter,
          authMode: "key",
          baseUrl: `https://rebind-${adapter}.example`,
          apiKey: "test-probe-token",
          models: ["fallback-model"],
        } as EpxConfig["providers"][string];

        const reqUrl = new URL(`http://127.0.0.1/api/providers/test?name=${encodeURIComponent(providerName)}`);
        const res = await handleManagementAPI(
          new ManagementRequest(reqUrl, { method: "POST" }),
          reqUrl,
          configWithProvider(providerName, provider),
        );
        expect(res?.status).toBe(200);
        const body = await res!.json() as { ok: boolean; error?: string };
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/loopback|metadata|private/i);

        const models = await gatherRoutedModels({
          providers: { [providerName]: provider },
        });
        expect(models.some(m => m.provider === providerName && m.id === "fallback-model")).toBe(true);
      }
      expect(dnsLookups).toBeGreaterThanOrEqual(4);
    }
    expect(fetchCalls).toBe(0);
  });

  test("prov.fetch never bypasses DNS checks on HTTP/2 cursor rows or devin rows", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-fetch-bypass-ssrf-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;

    let customFetchCalls = 0;
    const customFetch = (async () => {
      customFetchCalls += 1;
      return new Response(new Uint8Array(), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    let dnsCalls = 0;
    setBespokeProbeAddressResolverForTests(async (_url, opts) => {
      dnsCalls += 1;
      return resolvePublicAddresses("https://169.254.169.254", opts);
    });

    for (const adapter of ["cursor", "devin"] as const) {
      const providerName = `ssrf-${adapter}-probe`;
      clearModelCache(providerName);
      // Cursor omits upstreamHttpVersion: "http1.1" (so HTTP/2 pool would be used); Devin ignores prov.fetch.
      const cfg = configWithProvider(providerName, {
        adapter,
        authMode: "key",
        baseUrl: `https://bypass-${adapter}.example`,
        apiKey: "test-probe-token",
        models: [],
        fetch: customFetch,
      } as unknown as EpxConfig["providers"][string]);
      const reqUrl = new URL(`http://127.0.0.1/api/providers/test?name=${encodeURIComponent(providerName)}`);
      const res = await handleManagementAPI(
        new ManagementRequest(reqUrl, { method: "POST" }),
        reqUrl,
        cfg,
      );
      const body = await res!.json() as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/metadata|169\.254\.169\.254/i);
    }
    expect(dnsCalls).toBe(2);
    expect(customFetchCalls).toBe(0);
  });
});

describe("CursorH2SessionPool eviction", () => {
  test("request() with pinnedAddress dials the pinned peer without a second DNS lookup", async () => {
    const server = http2.createServer();
    server.on("stream", stream => {
      stream.respond({ ":status": 200 });
      stream.end("pinned-ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind TCP port");

    const pool = new CursorH2SessionPool(4, 60_000);
    try {
      // .invalid fails DNS if anything tries a second unpinned lookup; pinnedAddress bypasses DNS.
      const stream = pool.request(
        `http://pinned.invalid:${address.port}`,
        { ":method": "POST", ":path": "/pinned" },
        "scope-a",
        { address: "127.0.0.1", family: 4 },
      );
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      stream.end();
      expect(body).toBe("pinned-ok");
    } finally {
      await pool.shutdown();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  test("over-capacity eviction retires old session gracefully without destroying active in-flight streams", async () => {
    const startServer = async (onStream: (stream: http2.ServerHttp2Stream) => void) => {
      const server = http2.createServer();
      server.on("stream", stream => onStream(stream));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind TCP port");
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    };

    let releaseFirstStream!: () => void;
    const firstStreamOpened = new Promise<void>(resolve => {
      releaseFirstStream = resolve;
    });
    let serverAStream!: http2.ServerHttp2Stream;

    const srvA = await startServer(stream => {
      serverAStream = stream;
      releaseFirstStream();
    });
    const srvB = await startServer(stream => {
      stream.respond({ ":status": 200 });
      stream.end("second");
    });

    const pool = new CursorH2SessionPool(1, 60_000);
    try {
      const stream1 = pool.request(srvA.baseUrl, { ":method": "POST", ":path": "/first" });
      const body1Promise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream1.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream1.on("error", reject);
        stream1.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      stream1.end();
      await firstStreamOpened;

      const stream2 = pool.request(srvB.baseUrl, { ":method": "POST", ":path": "/second" });
      const body2Promise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream2.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream2.on("error", reject);
        stream2.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      stream2.end();
      expect(await body2Promise).toBe("second");
      expect(pool.size).toBe(1);

      // Now complete stream1 after session A was evicted from the pool map.
      serverAStream.respond({ ":status": 200 });
      serverAStream.end("first");
      expect(await body1Promise).toBe("first");
    } finally {
      await pool.shutdown();
      await new Promise<void>(resolve => srvA.server.close(() => resolve()));
      await new Promise<void>(resolve => srvB.server.close(() => resolve()));
    }
  });

  test("shutdown() destroys active streams on retired sessions without hanging", async () => {
    const startServer = async (onStream: (stream: http2.ServerHttp2Stream) => void) => {
      const server = http2.createServer();
      server.on("stream", stream => {
        stream.on("error", () => {});
        onStream(stream);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind TCP port");
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    };

    let releaseFirstStream!: () => void;
    const firstStreamOpened = new Promise<void>(resolve => { releaseFirstStream = resolve; });
    const srvA = await startServer(() => releaseFirstStream());
    const srvB = await startServer(stream => {
      stream.respond({ ":status": 200 });
      stream.end("second");
    });

    const pool = new CursorH2SessionPool(1, 60_000);
    try {
      const stream1 = pool.request(srvA.baseUrl, { ":method": "POST", ":path": "/hang" });
      stream1.on("error", () => {});
      stream1.end();
      await firstStreamOpened;

      // Opening stream2 evicts session A into retired set while stream1 stays active.
      const stream2 = pool.request(srvB.baseUrl, { ":method": "POST", ":path": "/second" });
      stream2.on("error", () => {});
      stream2.resume();
      await new Promise<void>(resolve => {
        stream2.on("end", () => resolve());
        stream2.end();
      });
      expect(pool.size).toBe(1);

      const started = Date.now();
      await pool.shutdown();
      const elapsedMs = Date.now() - started;

      expect(stream1.destroyed).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      await new Promise<void>(resolve => srvA.server.close(() => resolve()));
      await new Promise<void>(resolve => srvB.server.close(() => resolve()));
    }
  });
});
