import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relPath: string) => readFileSync(join(import.meta.dir, "..", relPath), "utf8");

test("boot script no longer routes users to /classic/", () => {
  const boot = read("public/boot.js");
  expect(boot).not.toContain("/classic/");
  expect(boot).not.toContain("classic");
});

test("v2 shell and advanced hub have retired classic UI switching", () => {
  const app = read("src/App.tsx");
  const advanced = read("src/pages/AdvancedHub.tsx");

  expect(app).not.toContain("dashboard-edition");
  expect(app).not.toContain("switchDashboardEdition");
  expect(app).not.toContain("classic-ui");
  expect(app).not.toContain("onSwitchClassic");
  expect(advanced).not.toContain("onSwitchClassic");
});

test("GUI build script builds only the unified v2 dashboard", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  expect(pkg.scripts.build).toBe("tsc -b && vite build");
  expect(pkg.scripts.build).not.toContain("vite.classic.config.ts");
});
