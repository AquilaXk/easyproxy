import { expect, test } from "bun:test";
import { buildServiceShellCommand } from "../../src/service/definition";
import { buildWinswXml } from "../../src/lib/winsw";
import { cliEntry } from "../../src/service/state";
import { buildWindowsServiceScript } from "../../src/service/windows-taskxml";

const runtime = {
  path: "/opt/easyproxy/epx",
  source: "standalone" as const,
  overrideEnv: "EASYPROXY_BUN_PATH" as const,
};

test("standalone service entries invoke the executable without a source CLI", () => {
  const entry = cliEntry(runtime);
  expect(entry).toEqual({ bun: runtime.path, bunRuntimeSource: "standalone", cli: null });
  expect(buildServiceShellCommand(entry.bun, entry.cli, 10177)).toContain(
    "exec '/opt/easyproxy/epx' start --port 10177",
  );
  expect(buildWindowsServiceScript(entry, 10177)).toContain(
    '"%EPX_BUN%" start --port 10177',
  );
  expect(buildWindowsServiceScript(entry, 10177)).not.toContain('"%EPX_BUN%" "%EPX_CLI%" start');
  expect(buildWinswXml(entry, { EPX_BAKE_PORT: "10177" })).toContain(
    "<arguments>start --port 10177</arguments>",
  );
});
