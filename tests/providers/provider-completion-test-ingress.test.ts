import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { chat, fixture } from "../helpers/provider-completion-fixture";
import * as pinnedHttp from "../../src/lib/pinned-http";
import * as destinationPolicy from "../../src/lib/destination-policy";

const previousAdmin = process.env.EASYPROXY_ADMIN_AUTH_TOKEN;
const previousData = process.env.EASYPROXY_API_AUTH_TOKEN;
let home: TempHome;
beforeEach(() => {
  home = createTempHome("epx-completion-ingress-");
  process.env.EASYPROXY_ADMIN_AUTH_TOKEN = "completion-admin-fixture";
  process.env.EASYPROXY_API_AUTH_TOKEN = "completion-data-fixture";
});
afterEach(() => {
  if (previousAdmin === undefined) delete process.env.EASYPROXY_ADMIN_AUTH_TOKEN; else process.env.EASYPROXY_ADMIN_AUTH_TOKEN = previousAdmin;
  if (previousData === undefined) delete process.env.EASYPROXY_API_AUTH_TOKEN; else process.env.EASYPROXY_API_AUTH_TOKEN = previousData;
  home.remove();
});

test("real management ingress rejects anonymous/data credentials, foreign Origin and GUI session without CSRF before any upstream send", async () => {
  // Exercise startServer's real auth/origin/CSRF gates rather than a fabricated route principal.
  const f = fixture({ proxy: "direct" });
  delete f.row.fetch;
  saveConfig(f.config);
  const server = startServer(0);
  const dns = spyOn(destinationPolicy, "resolvePublicAddresses").mockResolvedValue({
    hostname: "provider.example", addresses: [{ address: "93.184.216.34", family: 4 }], privateNetwork: false,
  });
  const sends = spyOn(pinnedHttp, "pinnedHttpPost").mockImplementation(async () => new Response(chat()));
  try {
    const target = new URL("/api/providers/test-completion?name=fixture", server.url);
    const post = (headers: Record<string, string>) => fetch(target, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "test-model", confirm: true }) });
    expect((await post({})).status).toBe(401);
    expect(sends).not.toHaveBeenCalled();
    expect((await post({ "x-easyproxy-api-key": "completion-data-fixture" })).status).toBe(401);
    expect(sends).not.toHaveBeenCalled();
    expect((await post({ "x-easyproxy-api-key": "completion-admin-fixture", Origin: "https://foreign.example" })).status).toBe(403);
    expect(sends).not.toHaveBeenCalled();
    const html = await (await fetch(new URL("/easyproxy-session", server.url))).text();
    const token = html.match(/name="easyproxy-session-token" content="([^"]+)"/)?.[1];
    const csrf = html.match(/name="easyproxy-session-csrf" content="([^"]+)"/)?.[1];
    expect(token).toBeDefined(); expect(csrf).toBeDefined();
    const missingCsrf = await post({ "x-easyproxy-api-key": token!, "x-easyproxy-gui-origin": server.url.origin, Origin: server.url.origin });
    expect([401, 403]).toContain(missingCsrf.status);
    expect(sends).not.toHaveBeenCalled();
    // Same ingress and pinned transport: an authorized request must reach this counter.
    const authorized = await post({ "x-easyproxy-api-key": "completion-admin-fixture" });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ applicable: true, ok: true, wire: "openai-chat" });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(sends.mock.calls[0]![0]).toBe("https://provider.example/v1/chat/completions");
    expect(JSON.parse(sends.mock.calls[0]![2]).model).toBe("test-model");
  } finally { sends.mockRestore(); dns.mockRestore(); await server.stop(true); }
});
