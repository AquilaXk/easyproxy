import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCodexInjectionPlan } from "../../src/codex/inject/plan";
import { EPX_ROUTING_MARKER_LINE, EPX_SECTION_MARKER } from "../../src/codex/injected-marker";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import {
  appendOcxProviderTableBlock,
  extractEpxProviderTableBlock,
  hasEpxProviderTable,
  removeEpxSection,
} from "../../src/codex/inject/remove";

const header = "[model_providers.easyproxy]\n";

describe("lossless retained provider tables", () => {
  test.each(['"""', "'''"])("different multiline contents remain a conflict (%s)", delimiter => {
    const captured = header + `name = ${delimiter}first\n\n\nlast${delimiter}\n`;
    const restored = header + `name = ${delimiter}first\n\nlast${delimiter}\n`;
    expect(extractEpxProviderTableBlock(captured)).toBe(captured);
    expect(() => appendOcxProviderTableBlock(restored, captured)).toThrow("different [model_providers.easyproxy] table");
  });

  test.each(['"""', "'''"])("header-shaped data stays within the captured string (%s)", delimiter => {
    const block = header + `name = ${delimiter}first\n[foreign]\n# Auto-injected by easyproxy\n\n\nlast${delimiter}\n`;
    const foreign = '[unrelated]\nvalue = "keep"\n';
    expect(extractEpxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeEpxSection(block + foreign)).toBe(foreign);
    expect(appendOcxProviderTableBlock(foreign, block)).toContain(block);
  });

  test("a fake provider header inside unrelated multiline data is not captured or removed", () => {
    const content = 'instructions = """start\n[model_providers.easyproxy]\nname = "fake"\nend"""\n';
    expect(hasEpxProviderTable(content)).toBe(false);
    expect(extractEpxProviderTableBlock(content)).toBeNull();
    expect(removeEpxSection(content)).toBe(content);
  });

  test("capture resumes for separated child tables without swallowing foreign content", () => {
    const root = header + 'name = "retained"\n';
    const foreign = '[other]\nnote = """a\n\n\nb"""\n';
    const child = '[model_providers.easyproxy.http_headers]\n"x-fixture" = "value"\n';
    const captured = root + child;
    expect(extractEpxProviderTableBlock(root + foreign + child)).toBe(captured);
    expect(removeEpxSection(root + foreign + child)).toBe(foreign);
    expect(appendOcxProviderTableBlock(root + foreign + child, captured)).toBe(root + foreign + child);
  });

  test("cosmetic formatting and quoted table paths preserve current bytes", () => {
    const captured = header + 'name = "retained"\nflag = true\n';
    const current = '["model_providers" . \'easyproxy\'] # retained\nflag=true\n\n\nname=\'retained\' # comment\n';
    expect(appendOcxProviderTableBlock(current, captured)).toBe(current);
  });

  test("capture does not parse unrelated integers outside JavaScript's safe range", () => {
    const prefix = "model_context_window = 9223372036854775807\n";
    const block = header + 'name = "retained"\n';
    expect(extractEpxProviderTableBlock(prefix + block)).toBe(block);
    expect(appendOcxProviderTableBlock(prefix + block, block)).toBe(prefix + block);
    expect(removeEpxSection(prefix + block)).toBe(prefix);
  });

  test("arrays and inline tables containing header-shaped multiline data stay opaque", () => {
    const block = header + 'name = "retained"\nvalues = [\n"""[foreign]\n\n\nlast""",\n{ label = "[another]" }\n]\n';
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractEpxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeEpxSection(block + foreign)).toBe(foreign);
    expect(appendOcxProviderTableBlock(block, block)).toBe(block);
  });

  test.each(['"""', "'''"])("closing quote runs and escaped quote text remain lossless (%s)", delimiter => {
    const quote = delimiter[0]!;
    const block = header + `name = ${delimiter}first\n\n\nlast${quote}${quote}${delimiter}\n`;
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractEpxProviderTableBlock(block + foreign)).toBe(block);
    expect(removeEpxSection(block + foreign)).toBe(foreign);
  });

  test("CRLF multiline content survives capture and reattachment", () => {
    const block = '[model_providers.easyproxy]\r\nname = """first\r\n\r\n\r\nlast"""\r\n';
    expect(extractEpxProviderTableBlock(block)).toBe(block);
    expect(appendOcxProviderTableBlock("", block)).toContain(block);
  });

  test("a leading BOM stays at the document boundary rather than moving with the table", () => {
    const block = header + 'name = "retained"\n';
    const foreign = '[other]\nvalue = "keep"\n';
    expect(extractEpxProviderTableBlock("\uFEFF" + block + foreign)).toBe(block);
    expect(removeEpxSection("\uFEFF" + block + foreign)).toBe("\uFEFF" + foreign);
    expect(appendOcxProviderTableBlock("\uFEFF" + foreign, block)).toBe("\uFEFF" + foreign + "\n" + block);
  });

  test.each([
    header + 'name = "unterminated\n',
    header + 'name = """unterminated\n',
    header + 'name = "one"\n' + header + 'name = "two"\n',
    '[[model_providers.easyproxy]]\nname = "array"\n',
  ])("malformed or duplicate owned tables refuse before retention", content => {
    const valid = header + 'name = "retained"\n';
    expect(() => appendOcxProviderTableBlock(content, valid)).toThrow();
    expect(() => appendOcxProviderTableBlock("", content)).toThrow();
  });

  test.each([
    'model_providers.easyproxy = { name = "inline" }\n',
    '"model_providers"."openco\\u0064ex" = { name = "inline" }\n',
    '[model_providers]\neasyproxy = { name = "inline" }\n',
  ])("unsupported inline definitions are refused rather than duplicated", content => {
    expect(() => appendOcxProviderTableBlock(content, header + 'name = "retained"\n')).toThrow();
  });
});

describe("provider table ownership markers", () => {
  const variants = ["\n", "\r\n"].flatMap(eol => ["", "\uFEFF"].flatMap(bom =>
    [EPX_SECTION_MARKER, EPX_ROUTING_MARKER_LINE].map(marker => ({ eol, bom, marker }))));

  test.each(variants)("capture and removal own only the adjacent exact marker (%j)", ({ eol, bom, marker }) => {
    const prefix = '# user comment\nmodel = "fixture-model"\n'.replaceAll("\n", eol);
    const block = `${marker}\n${header}name = "fixture"\n`.replaceAll("\n", eol);
    const foreign = '[user]\nnote = "keep"\n'.replaceAll("\n", eol);
    expect(extractEpxProviderTableBlock(bom + prefix + block + foreign)).toBe(block);
    expect(removeEpxSection(bom + prefix + block + foreign)).toBe(bom + prefix + foreign);
    expect(appendOcxProviderTableBlock(bom + prefix + block + foreign, block)).toBe(bom + prefix + block + foreign);
  });

  test.each(["\n", "\r\n"])("real reinjection plans are byte idempotent (%j)", eol => {
    for (const bom of ["", "\uFEFF"]) {
      const ctx = {
        config: undefined,
        routingTarget: { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: true, tokenEnv: "EASYPROXY_API_AUTH_TOKEN" as const },
        catalogPathOption: null,
        journalReadOnly: true,
      };
      // A foreign table before the provider prevents root-marker cleanup from masking this bug.
      const native = bom + '# user comment\nmodel = "fixture-model"\n[user]\nnote = "fixture"\n'.replaceAll("\n", eol);
      const first = deriveCodexInjectionPlan(native, ctx);
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") throw new Error(first.message);
      let current = first.content;
      for (let cycle = 0; cycle < 5; cycle++) {
        const next = deriveCodexInjectionPlan(current, ctx);
        expect(next.kind).toBe("ok");
        if (next.kind !== "ok") throw new Error(next.message);
        expect(next.content).toBe(first.content);
        expect(next.content.split(eol).filter(line => line.trim() === EPX_ROUTING_MARKER_LINE)).toHaveLength(1);
        current = next.content;
      }
      expect(current.startsWith(bom + "# user comment")).toBe(true);
    }
  });

  test.each([
    `${EPX_SECTION_MARKER} user note`,
    `${EPX_ROUTING_MARKER_LINE} user note`,
    `# user quoted ${EPX_ROUTING_MARKER_LINE}`,
    `${EPX_ROUTING_MARKER_LINE}\n`,
  ])("user comments and nonadjacent orphan markers remain untouched (%s)", comment => {
    const prefix = `${comment}\n`;
    const block = header + 'name = "fixture"\n';
    expect(extractEpxProviderTableBlock(prefix + block)).toBe(block);
    expect(removeEpxSection(prefix + block)).toBe(prefix);
  });

  test.each(['"""', "'''"])("multiline marker data and separated child tables stay lossless (%s)", delimiter => {
    const foreign = `[user]\nnote = ${delimiter}start\n${EPX_ROUTING_MARKER_LINE}\n[model_providers.easyproxy]\nend${delimiter}\n`;
    const root = `${EPX_ROUTING_MARKER_LINE}\n${header}name = "fixture"\n`;
    const child = `${EPX_SECTION_MARKER}\n[model_providers.easyproxy.http_headers]\n"x-fixture" = "value"\n`;
    expect(extractEpxProviderTableBlock(root + foreign + child)).toBe(root + child);
    expect(removeEpxSection(root + foreign + child)).toBe(foreign);
    expect(removeEpxSection(foreign)).toBe(foreign);
  });

  test("provider ownership leaves root routing marker pairs intact", () => {
    const root = `${EPX_ROUTING_MARKER_LINE}\nopenai_base_url = "https://fixture.invalid/v1"\n`;
    const block = `${EPX_ROUTING_MARKER_LINE}\n${header}name = "fixture"\n`;
    expect(removeEpxSection(root + block)).toBe(root);
    expect(extractEpxProviderTableBlock(root + block)).toBe(block);
  });

  test("a journal byte mismatch takes fallback restore without orphaning the provider marker", () => {
    const fixture = mkdtempSync(join(tmpdir(), "epx-provider-marker-"));
    const codexHome = join(fixture, "codex");
    const epxHome = join(fixture, "easyproxy");
    mkdirSync(codexHome);
    mkdirSync(epxHome);
    writeFileSync(join(codexHome, "config.toml"), '# user comment\nmodel = "fixture-model"\n[user]\nnote = "fixture"\n');
    const script = `
      import { readFileSync, appendFileSync } from "node:fs";
      import { createHash } from "node:crypto";
      import { join } from "node:path";
      import { injectCodexConfig, restoreNativeCodex } from "./src/codex/inject";
      const configPath = join(process.env.CODEX_HOME, "config.toml");
      await injectCodexConfig(10100, {
        port: 10100, providers: {}, defaultProvider: "openai",
        codexDesktopAuthless: true,
      }, { catalogPath: null });
      const before = readFileSync(configPath, "utf8");
      const journal = JSON.parse(readFileSync(join(process.env.CODEX_HOME, "easyproxy-journal.json"), "utf8"));
      const hash = content => createHash("sha256").update(content).digest("hex");
      if (!journal.injectedConfigHash || journal.injectedConfigHash !== hash(before)) {
        throw new Error("fixture must have a journal matching the injected bytes");
      }
      appendFileSync(configPath, '\\n[user_edit]\\nvalue = "keep"\\n');
      if (journal.injectedConfigHash === hash(readFileSync(configPath, "utf8"))) {
        throw new Error("fixture must force a journal hash mismatch");
      }
      const result = restoreNativeCodex({ skipHistory: true, removeProviderTable: true });
      console.log(JSON.stringify({ before, after: readFileSync(configPath, "utf8"), success: result.success, action: result.artifacts.config.action }));
    `;
    try {
      const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
        cwd: repoRoot(),
        env: { ...process.env, CODEX_HOME: codexHome, EASYPROXY_HOME: epxHome },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS,
      });
      if (child.error || child.status !== 0) throw new Error(`fixture child failed: ${child.error?.message ?? child.stderr}`);
      const result = JSON.parse(child.stdout.trim());
      expect(result.before).toContain(EPX_ROUTING_MARKER_LINE);
      expect(result.before).toContain("[model_providers.easyproxy]");
      expect(result.success).toBe(true);
      expect(result.action).toBe("owned-fields-stripped");
      expect(result.after).not.toContain(EPX_ROUTING_MARKER_LINE);
      expect(result.after).not.toContain("[model_providers.easyproxy]");
      expect(result.after).toContain("# user comment");
      expect(Bun.TOML.parse(result.after)).toEqual({ model: "fixture-model", user: { note: "fixture" }, user_edit: { value: "keep" } });
    } finally {
      removeTreeWithRetry(fixture);
    }
  }, 2 * SPAWN_BUDGET_MS);
});
