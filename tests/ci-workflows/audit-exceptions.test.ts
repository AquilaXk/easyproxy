import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// Keep ignored GUI build-tool advisories empty unless an unpatched upstream advisory is explicitly reviewed.
const ALLOWED_GUI_IGNORES: readonly string[] = [];

test("the prepublish audit enforces strict checks without unreviewed GUI ignore exceptions", () => {
  const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> };
  const [root, gui, ...rest] = pkg.scripts["audit:high"]!.split("&&").map(part => part.trim());
  expect(rest).toEqual(["bun audit --audit-level=high" + ALLOWED_GUI_IGNORES.map(id => ` --ignore=${id}`).join("")]);
  expect(root).toBe("bun audit --audit-level=high");
  expect(gui).toBe("cd gui");
  expect(pkg.scripts.prepublishOnly).toContain("bun run audit:high");
});
