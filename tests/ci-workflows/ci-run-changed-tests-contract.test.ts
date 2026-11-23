import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

describe("run-changed-tests CI contract", () => {
  test("ci.yml passes BASE_SHA to the changed-file test step", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/ci.yml"), "utf8")) as {
      jobs?: {
        gates?: {
          steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
        };
      };
    };
    const step = (workflow.jobs?.gates?.steps ?? []).find((item) => item.run?.includes("scripts/ci/run-changed-tests.sh"));
    expect(step).toBeDefined();
    expect(step?.env?.BASE_SHA).toContain("github.event.pull_request.base.sha");
    expect(step?.env?.BASE_SHA).toContain("github.event.before");
  });

  test("run-changed-tests.sh resolves BASE_SHA via merge-base before falling back to HEAD^1 and isolates storage/usage families", () => {
    const script = readFileSync(repoPath("scripts/ci/run-changed-tests.sh"), "utf8");
    expect(script).toContain('git merge-base "${BASE_SHA}" HEAD');
    expect(script).toContain("HEAD^1^{commit}");
    expect(script).toContain("api-storage-policy*.test.ts");
    expect(script).toContain("api-storage.test.ts");
    expect(script).toContain("api-usage.test.ts");
    expect(script).toContain("tests/server/api-usage.test.ts");
  });
});
