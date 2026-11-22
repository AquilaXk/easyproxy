import { describe, expect, test } from "bun:test";
import { scanText } from "../../scripts/privacy-scan";

const canary = ["LLM", "1".repeat(16), "c".repeat(27)].join("|");
const sampleContact = ["alice", "corp-internal.org"].join("@");

describe("privacy scan: email detection", () => {
  test("rejects non-placeholder email addresses across tracked files", () => {
    const line = `Email: ${sampleContact}`;
    for (const file of ["README.md", "readme/README.ko.md", "src/example.ts", "docs-site/src/content/docs/index.mdx"]) {
      expect(scanText(file, line).some(f => f.kind === "email")).toBe(true);
    }
  });

  test("allows RFC 2606 example domains", () => {
    expect(scanText("README.md", "Email: user@example.com").filter(f => f.kind === "email")).toEqual([]);
  });
});

describe("privacy scan: Meta API keys", () => {
  test("flags a Meta-shaped key in a tracked file", () => {
    const findings = scanText("src/example.ts", `const key = "${canary}";`);
    expect(findings.some(f => f.kind === "meta-api-key")).toBe(true);
  });

  test("the pre-existing token patterns would have missed it", () => {
    const findings = scanText("src/example.ts", `const key = "${canary}";`);
    expect(findings.some(f => f.kind === "token-looking")).toBe(false);
  });

  test("ordinary prose mentioning the prefix is not a finding", () => {
    const findings = scanText("docs-site/example.md", "Meta keys start with an LLM| prefix.");
    expect(findings.some(f => f.kind === "meta-api-key")).toBe(false);
  });

  test("a Bearer header carrying one is still caught", () => {
    const findings = scanText("src/example.ts", `Authorization: Bearer ${canary}`);
    expect(findings.length).toBeGreaterThan(0);
  });
});
