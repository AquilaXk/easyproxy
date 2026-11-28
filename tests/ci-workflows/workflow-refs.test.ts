import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const ROOT = repoPath(".");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function packageScripts(dir: string): Set<string> {
  const pkgPath = dir ? `${dir}/package.json` : "package.json";
  const parsed = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
  return new Set(Object.keys(parsed.scripts ?? {}));
}

const PACKAGE_SCRIPTS: Record<string, Set<string>> = {
  "": packageScripts(""),
  gui: packageScripts("gui"),
  desktop: packageScripts("desktop"),
  "docs-site": packageScripts("docs-site"),
};

function workflowAndActionFiles(): string[] {
  const workflows = readdirSync(join(ROOT, ".github/workflows"))
    .filter(name => /\.ya?ml$/.test(name))
    .sort()
    .map(name => `.github/workflows/${name}`);
  const actionsDir = join(ROOT, ".github/actions");
  const actions = existsSync(actionsDir)
    ? readdirSync(actionsDir)
        .sort()
        .map(name => `.github/actions/${name}/action.yml`)
        .filter(path => existsSync(join(ROOT, path)))
    : [];
  return [...workflows, ...actions];
}

const REPO_PATH_RE =
  /(?<![\w./-])((?:scripts|desktop\/scripts|\.github\/(?:workflows|actions)|native\/[\w-]+)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|sh|ps1|py|json|ya?ml|toml|rs))(?![\w/-])/g;

const BUN_RUN_RE =
  /\bbun\s+run\s+(?:--cwd\s+(\S+)\s+)?([\w:.-]+)/g;

const EXTERNAL_USES_RE = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;
const PINNED_ACTION_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
const FUNDING_YAML_MAX_BYTES = 4096;
const PACKAGE_JSON_MAX_BYTES = 262_144;
const README_MAX_BYTES = 524_288;
const LOCALE_READMES_MAX_ENTRIES = 16;
const GITHUB_FUNDING_MAX_HANDLES = 4;
const CUSTOM_FUNDING_MAX_URLS = 4;
const GITHUB_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const ALLOWED_FUNDING_YAML_KEYS = new Set([
  "github",
  "patreon",
  "open_collective",
  "ko_fi",
  "tidelift",
  "community_bridge",
  "liberapay",
  "issuehunt",
  "lfx_crowdfunding",
  "polar",
  "buy_me_a_coffee",
  "thanks_dev",
  "custom",
]);

function validateReadmeSponsorSurface(
  markdown: string,
  label: string,
  primaryHandle: string,
  requireEnglishHeadings: boolean,
): string[] {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes === 0 || markdown.trim().length === 0) {
    return [`${label} is empty`];
  }
  if (bytes > README_MAX_BYTES) {
    return [`${label} exceeds ${README_MAX_BYTES} bytes`];
  }

  const expectedSponsorsUrl = `https://github.com/sponsors/${primaryHandle}`;
  let missingSectionSponsorLink = false;

  if (requireEnglishHeadings) {
    const sponsorHeading = /^## Sponsor$/m.exec(markdown);
    if (!sponsorHeading) {
      errors.push(`${label} is missing ## Sponsor followed by ### Supporters heading`);
    } else {
      const afterSponsorHeading = markdown.slice(sponsorHeading.index + sponsorHeading[0].length);
      const nextH2 = /\n##\s+/m.exec(afterSponsorHeading);
      const sponsorSection = nextH2 ? afterSponsorHeading.slice(0, nextH2.index) : afterSponsorHeading;
      const supportersHeading = /^### Supporters$/m.exec(sponsorSection);
      if (!supportersHeading) {
        errors.push(`${label} is missing ## Sponsor followed by ### Supporters heading`);
      } else {
        const headerBody = markdown.slice(0, sponsorHeading.index);
        const sponsorBody = sponsorSection.slice(0, supportersHeading.index);
        const supportersRest = sponsorSection.slice(supportersHeading.index + supportersHeading[0].length);
        const nextH3 = /\n###\s+/m.exec(supportersRest);
        const supportersBody = nextH3 ? supportersRest.slice(0, nextH3.index) : supportersRest;
        if (
          !headerBody.includes(expectedSponsorsUrl) ||
          !sponsorBody.includes(expectedSponsorsUrl) ||
          !supportersBody.includes(expectedSponsorsUrl)
        ) {
          missingSectionSponsorLink = true;
        }
      }
    }
  }

  if (/http:\/\/(?:www\.)?(?:github\.com|img\.shields\.io\/github)\/sponsors(?:\b|\/|$)/i.test(markdown)) {
    errors.push(`${label} contains non-HTTPS GitHub Sponsors URL`);
  }

  const badgeMatches = [
    ...markdown.matchAll(/https:\/\/img\.shields\.io\/github\/sponsors(?:\/([^\s"'<>?&#)]*))?/gi),
  ];
  if (badgeMatches.length === 0) {
    errors.push(`${label} is missing Shields GitHub Sponsors badge for ${primaryHandle}`);
  }
  for (const match of badgeMatches) {
    const rawSegment = (match[1] ?? "").replace(/\.(?:svg|json)$/i, "");
    if (!match[0].startsWith("https://img.shields.io/github/sponsors/") || rawSegment !== primaryHandle) {
      errors.push(`${label} has mismatched Shields GitHub Sponsors badge target: ${JSON.stringify(match[0])}`);
    }
  }

  const sponsorUrlMatches = [
    ...markdown.matchAll(/https:\/\/(?:www\.)?github\.com\/sponsors(?:\/([^\s"'<>?&#)\]]*))?/gi),
  ];
  if (sponsorUrlMatches.length < 3 || missingSectionSponsorLink) {
    errors.push(`${label} must link to ${expectedSponsorsUrl} in badge, Sponsor, and Supporters sections`);
  }
  for (const match of sponsorUrlMatches) {
    if (!match[0].startsWith("https://github.com/sponsors/")) {
      errors.push(`${label} must use canonical https://github.com/sponsors/${primaryHandle}, got ${JSON.stringify(match[0])}`);
      continue;
    }
    const rawHandle = (match[1] ?? "").replace(/[.,;:。，；：]+$/u, "");
    if (rawHandle.length === 0) {
      errors.push(`${label} contains placeholder GitHub Sponsors URL without handle`);
      continue;
    }
    if (rawHandle !== primaryHandle) {
      errors.push(`${label} links to mismatched GitHub Sponsors handle: ${rawHandle}`);
    }
  }

  const bareSponsorMatches = [
    ...markdown.matchAll(/(?<![:/\w.-])(?:www\.)?github\.com\/sponsors(?:\/([^\s"'<>?&#)\]]*))?/gi),
  ];
  for (const match of bareSponsorMatches) {
    if (!match[0].startsWith("github.com/sponsors/")) {
      errors.push(`${label} must use canonical github.com/sponsors/${primaryHandle}, got ${JSON.stringify(match[0])}`);
      continue;
    }
    const rawHandle = (match[1] ?? "").replace(/[.,;:。，；：]+$/u, "");
    if (rawHandle.length === 0) {
      errors.push(`${label} contains placeholder GitHub Sponsors URL without handle`);
      continue;
    }
    if (rawHandle !== primaryHandle) {
      errors.push(`${label} links to mismatched GitHub Sponsors handle: ${rawHandle}`);
    }
  }

  return errors;
}

export function validateRepositoryFundingMetadata(
  fundingYamlRaw: string,
  packageJsonRaw: string,
  readmeMarkdown: string,
  localeReadmes: Record<string, string> = {},
): string[] {
  const errors: string[] = [];
  const yamlBytes = Buffer.byteLength(fundingYamlRaw, "utf8");
  if (yamlBytes === 0 || fundingYamlRaw.trim().length === 0) {
    return [".github/FUNDING.yml is empty"];
  }
  if (yamlBytes > FUNDING_YAML_MAX_BYTES) {
    return [`.github/FUNDING.yml exceeds ${FUNDING_YAML_MAX_BYTES} bytes`];
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = Bun.YAML.parse(fundingYamlRaw);
  } catch {
    return [".github/FUNDING.yml is not valid YAML"];
  }
  if (!parsedYaml || typeof parsedYaml !== "object" || Array.isArray(parsedYaml)) {
    return [".github/FUNDING.yml must parse to a YAML mapping"];
  }

  const yamlRecord = parsedYaml as Record<string, unknown>;
  for (const key of Object.keys(yamlRecord)) {
    if (!ALLOWED_FUNDING_YAML_KEYS.has(key)) {
      return [`.github/FUNDING.yml contains unrecognized key: ${JSON.stringify(key)}`];
    }
  }

  if (yamlRecord.custom !== undefined) {
    const customUrls = typeof yamlRecord.custom === "string"
      ? [yamlRecord.custom]
      : Array.isArray(yamlRecord.custom)
        ? yamlRecord.custom
        : null;
    if (!customUrls || customUrls.length === 0 || customUrls.length > CUSTOM_FUNDING_MAX_URLS) {
      return [`.github/FUNDING.yml custom must list 1..${CUSTOM_FUNDING_MAX_URLS} HTTPS URLs`];
    }
    for (const rawUrl of customUrls) {
      if (typeof rawUrl !== "string") {
        return [`.github/FUNDING.yml custom URL must be a string: ${JSON.stringify(rawUrl)}`];
      }
      let parsedCustom: URL;
      try {
        parsedCustom = new URL(rawUrl);
      } catch {
        return [`.github/FUNDING.yml custom URL is invalid: ${JSON.stringify(rawUrl)}`];
      }
      if (parsedCustom.protocol !== "https:") {
        return [`.github/FUNDING.yml custom URL must use HTTPS: ${JSON.stringify(rawUrl)}`];
      }
    }
  }

  const rawGithub = yamlRecord.github;
  const handles = typeof rawGithub === "string"
    ? [rawGithub]
    : Array.isArray(rawGithub)
      ? rawGithub
      : [];
  if (handles.length === 0 || handles.length > GITHUB_FUNDING_MAX_HANDLES) {
    return [`.github/FUNDING.yml github must list 1..${GITHUB_FUNDING_MAX_HANDLES} handles`];
  }
  const seenHandles = new Set<string>();
  for (const entry of handles) {
    if (typeof entry !== "string" || !GITHUB_HANDLE_RE.test(entry)) {
      return [`invalid GitHub Sponsors handle in .github/FUNDING.yml: ${JSON.stringify(entry)}`];
    }
    const lower = entry.toLowerCase();
    if (seenHandles.has(lower)) {
      return [`duplicate GitHub Sponsors handle in .github/FUNDING.yml: ${JSON.stringify(entry)}`];
    }
    seenHandles.add(lower);
  }

  const primaryHandle = handles[0] as string;
  const expectedSponsorsUrl = `https://github.com/sponsors/${primaryHandle}`;

  const pkgBytes = Buffer.byteLength(packageJsonRaw, "utf8");
  if (pkgBytes === 0 || packageJsonRaw.trim().length === 0) {
    return ["package.json is empty"];
  }
  if (pkgBytes > PACKAGE_JSON_MAX_BYTES) {
    return [`package.json exceeds ${PACKAGE_JSON_MAX_BYTES} bytes`];
  }

  let pkg: Record<string, unknown>;
  try {
    const parsedPkg = JSON.parse(packageJsonRaw) as unknown;
    if (!parsedPkg || typeof parsedPkg !== "object" || Array.isArray(parsedPkg)) {
      return ["package.json must be a JSON object"];
    }
    pkg = parsedPkg as Record<string, unknown>;
  } catch {
    return ["package.json is not valid JSON"];
  }

  const funding = pkg.funding;
  const fundingKeys = funding && typeof funding === "object" && !Array.isArray(funding)
    ? Object.keys(funding as Record<string, unknown>)
    : [];
  if (
    fundingKeys.length !== 2 ||
    !fundingKeys.every(key => key === "type" || key === "url") ||
    (funding as Record<string, unknown>).type !== "github" ||
    (funding as Record<string, unknown>).url !== expectedSponsorsUrl
  ) {
    errors.push(`package.json funding must be { type: "github", url: "${expectedSponsorsUrl}" }`);
  }

  errors.push(...validateReadmeSponsorSurface(readmeMarkdown, "README.md", primaryHandle, true));

  const localeEntries = Object.entries(localeReadmes);
  if (localeEntries.length > LOCALE_READMES_MAX_ENTRIES) {
    errors.push(`localeReadmes exceeds ${LOCALE_READMES_MAX_ENTRIES} entries`);
    return errors;
  }
  for (const [localeLabel, localeMarkdown] of localeEntries) {
    errors.push(...validateReadmeSponsorSurface(localeMarkdown, localeLabel, primaryHandle, false));
  }

  return errors;
}

export function findMissingPathReferences(
  line: string,
  exists: (relativePath: string) => boolean = relativePath =>
    statSync(join(ROOT, relativePath), { throwIfNoEntry: false }) !== undefined,
): string[] {
  const missing: string[] = [];
  for (const match of line.matchAll(REPO_PATH_RE)) {
    const candidate = match[1]!;
    if (/[$*{}<>]/.test(candidate) || /\/(?:target|dist)\//.test(candidate)) continue;
    if (!exists(candidate)) {
      missing.push(candidate);
    }
  }
  return missing;
}

describe("GitHub workflow and action reference integrity", () => {
  test("every .github workflow and action YAML parses cleanly", () => {
    const files = workflowAndActionFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const parsed = Bun.YAML.parse(readText(file));
      expect(parsed, file).toBeTruthy();
    }
  });

  test("every repository path referenced in workflows exists on disk", () => {
    const missing: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          for (const target of findMissingPathReferences(line)) {
            missing.push(`${file}:${index + 1} ${target}`);
          }
        });
    }
    expect(missing).toEqual([]);
  });

  test("missing workflow path validator catches stale script references", () => {
    expect(
      findMissingPathReferences("run: bun scripts/ci/does-not-exist.ts", () => false),
    ).toEqual(["scripts/ci/does-not-exist.ts"]);
    expect(
      findMissingPathReferences("path: desktop/src-tauri/target/x86_64/release/bundle.deb", () => false),
    ).toEqual([]);
  });

  test("every bun run script referenced in workflows exists in its package.json", () => {
    const missing: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(BUN_RUN_RE)) {
            const cwd = (match[1] ?? "").replace(/^["']|["']$/g, "");
            const script = match[2]!;
            if (script.endsWith(".ts") || script.endsWith(".js") || script.endsWith(".mjs")) continue;
            if (cwd && !(cwd in PACKAGE_SCRIPTS)) continue;
            const known = cwd
              ? PACKAGE_SCRIPTS[cwd]!
              : new Set([...PACKAGE_SCRIPTS[""]!, ...PACKAGE_SCRIPTS.gui!, ...PACKAGE_SCRIPTS.desktop!]);
            if (!known.has(script)) {
              missing.push(`${file}:${index + 1} bun run ${cwd ? `--cwd ${cwd} ` : ""}${script}`);
            }
          }
        });
    }
    expect(missing).toEqual([]);
  });

  test("external actions are pinned to 40-char commit SHAs and never use deprecated actions/cache v4", () => {
    const violations: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          const match = EXTERNAL_USES_RE.exec(line);
          if (!match) return;
          const target = match[1]!;
          if (target.startsWith("./")) return;
          if (!PINNED_ACTION_RE.test(target)) {
            violations.push(`${file}:${index + 1} unpinned action reference: ${target}`);
          }
          if (target.startsWith("actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830")) {
            violations.push(`${file}:${index + 1} legacy Node 20 actions/cache v4 SHA`);
          }
        });
    }
    expect(violations).toEqual([]);
  });

  test("README assets/ targets exist on disk, relative embeds are packed, and header badges match release channel", () => {
    const pkg = JSON.parse(readText("package.json")) as { files?: string[] };
    const pkgFiles = new Set(pkg.files ?? []);
    const readme = readText("README.md");
    const releaseWorkflow = readText(".github/workflows/release.yml");
    const allAssetRefs = new Set<string>();
    const relativeEmbeds = new Set<string>();
    for (const match of readme.matchAll(/assets\/[\w.-]+\.(?:png|gif|svg|jpe?g|webp)/g)) {
      allAssetRefs.add(match[0]);
    }
    for (const match of readme.matchAll(/(?:src=["']|\]\()(assets\/[\w.-]+\.(?:png|gif|svg|jpe?g|webp))/g)) {
      relativeEmbeds.add(match[1]!);
    }
    expect(relativeEmbeds.size).toBeGreaterThanOrEqual(4);
    for (const rel of allAssetRefs) {
      expect(existsSync(join(ROOT, rel)), `missing ${rel}`).toBe(true);
    }
    for (const rel of relativeEmbeds) {
      expect(pkgFiles.has(rel) || pkgFiles.has("assets"), `unpacked ${rel}`).toBe(true);
    }
    if (!/\bnpm\s+publish\b/.test(releaseWorkflow)) {
      expect(readme).not.toMatch(/img\.shields\.io\/(?:npm\/[vl]|node\/v)\/easyproxy\b/i);
    }
  });

  test(".github/FUNDING.yml, package.json funding, and README + locale Sponsor links agree", () => {
    const manifest = JSON.parse(readText("readme/i18n-manifest.json")) as {
      locales: Record<string, { file: string }>;
    };
    const localeReadmes: Record<string, string> = {};
    for (const entry of Object.values(manifest.locales)) {
      localeReadmes[entry.file] = readText(entry.file);
    }
    expect(Object.keys(localeReadmes).length).toBeGreaterThanOrEqual(7);
    expect(
      validateRepositoryFundingMetadata(
        readText(".github/FUNDING.yml"),
        readText("package.json"),
        readText("README.md"),
        localeReadmes,
      ),
    ).toEqual([]);
  });

  test("funding metadata validator rejects empty, oversized, malformed, and mismatched inputs", () => {
    const validPkg = JSON.stringify({
      funding: { type: "github", url: "https://github.com/sponsors/AquilaXk" },
    });
    const validReadme = [
      "[![Sponsors](https://img.shields.io/github/sponsors/AquilaXk?style=flat-square)](https://github.com/sponsors/AquilaXk)",
      "## Sponsor",
      "[github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk).",
      "### Supporters",
      "[become a sponsor](https://github.com/sponsors/AquilaXk).",
    ].join("\n");
    const validLocaleReadme = [
      "[![Sponsors](https://img.shields.io/github/sponsors/AquilaXk?style=flat-square)](https://github.com/sponsors/AquilaXk)",
      "## 후원",
      "[github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk)",
      "### 후원자",
      "[후원하기](https://github.com/sponsors/AquilaXk)",
    ].join("\n");

    expect(validateRepositoryFundingMetadata("", validPkg, validReadme)).toEqual([
      ".github/FUNDING.yml is empty",
    ]);
    expect(validateRepositoryFundingMetadata("   \n", validPkg, validReadme)).toEqual([
      ".github/FUNDING.yml is empty",
    ]);
    expect(
      validateRepositoryFundingMetadata(`github: [${"a".repeat(FUNDING_YAML_MAX_BYTES)}]`, validPkg, validReadme),
    ).toEqual([`.github/FUNDING.yml exceeds ${FUNDING_YAML_MAX_BYTES} bytes`]);
    expect(
      validateRepositoryFundingMetadata("github: [AquilaXk]\ngithbu: [AquilaXk]\n", validPkg, validReadme),
    ).toEqual(['.github/FUNDING.yml contains unrecognized key: "githbu"']);
    expect(
      validateRepositoryFundingMetadata('github: [AquilaXk]\ncustom: ["http://example.com/sponsor"]\n', validPkg, validReadme),
    ).toEqual(['.github/FUNDING.yml custom URL must use HTTPS: "http://example.com/sponsor"']);
    expect(validateRepositoryFundingMetadata("github: [-invalid]\n", validPkg, validReadme)).toEqual([
      'invalid GitHub Sponsors handle in .github/FUNDING.yml: "-invalid"',
    ]);
    expect(validateRepositoryFundingMetadata("github: [AquilaXk, aquilaxk]\n", validPkg, validReadme)).toEqual([
      'duplicate GitHub Sponsors handle in .github/FUNDING.yml: "aquilaxk"',
    ]);
    expect(
      validateRepositoryFundingMetadata("github: [u1, u2, u3, u4, u5]\n", validPkg, validReadme),
    ).toEqual([`.github/FUNDING.yml github must list 1..${GITHUB_FUNDING_MAX_HANDLES} handles`]);
    expect(
      validateRepositoryFundingMetadata("github: [AquilaXk]\n", "x".repeat(PACKAGE_JSON_MAX_BYTES + 1), validReadme),
    ).toEqual([`package.json exceeds ${PACKAGE_JSON_MAX_BYTES} bytes`]);
    expect(
      validateRepositoryFundingMetadata("github: [AquilaXk]\n", validPkg, "x".repeat(README_MAX_BYTES + 1)),
    ).toEqual([`README.md exceeds ${README_MAX_BYTES} bytes`]);
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        JSON.stringify({ funding: { type: "github", url: "http://github.com/sponsors/AquilaXk" } }),
        validReadme,
      ),
    ).toEqual([
      'package.json funding must be { type: "github", url: "https://github.com/sponsors/AquilaXk" }',
    ]);
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        JSON.stringify({ funding: { type: "github", url: "https://github.com/sponsors/AquilaXk", extra: true } }),
        validReadme,
      ),
    ).toEqual([
      'package.json funding must be { type: "github", url: "https://github.com/sponsors/AquilaXk" }',
    ]);
    // Prefix collision on Shields badge handle ("Aquila" vs "AquilaXk")
    expect(
      validateRepositoryFundingMetadata(
        "github: [Aquila]\n",
        JSON.stringify({ funding: { type: "github", url: "https://github.com/sponsors/Aquila" } }),
        [
          "[![Sponsors](https://img.shields.io/github/sponsors/AquilaXk?style=flat-square)](https://github.com/sponsors/Aquila)",
          "## Sponsor",
          "[github.com/sponsors/Aquila](https://github.com/sponsors/Aquila)",
          "### Supporters",
          "[become a sponsor](https://github.com/sponsors/Aquila)",
        ].join("\n"),
      ),
    ).toContain('README.md has mismatched Shields GitHub Sponsors badge target: "https://img.shields.io/github/sponsors/AquilaXk"');
    // Placeholder empty handle URL, subpath URL, www host, and uppercase HTTP scheme
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        `${validReadme}\n[placeholder](https://github.com/sponsors/)`,
      ),
    ).toContain("README.md contains placeholder GitHub Sponsors URL without handle");
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("https://github.com/sponsors/AquilaXk", "https://github.com/sponsors/AquilaXk/extra"),
      ),
    ).toContain("README.md links to mismatched GitHub Sponsors handle: AquilaXk/extra");
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("https://github.com/sponsors/AquilaXk", "https://www.github.com/sponsors/AquilaXk"),
      ),
    ).toContain('README.md must use canonical https://github.com/sponsors/AquilaXk, got "https://www.github.com/sponsors/AquilaXk"');
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        `${validReadme}\nHTTP://GITHUB.COM/SPONSORS/AquilaXk`,
      ),
    ).toContain("README.md contains non-HTTPS GitHub Sponsors URL");
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("[become a sponsor](https://github.com/sponsors/AquilaXk).", "Your name here."),
      ),
    ).toContain("README.md must link to https://github.com/sponsors/AquilaXk in badge, Sponsor, and Supporters sections");
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("https://github.com/sponsors/AquilaXk", "https://github.com/sponsors/OtherUser"),
      ),
    ).toContain("README.md links to mismatched GitHub Sponsors handle: OtherUser");
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("### Supporters\n", ""),
      ),
    ).toContain("README.md is missing ## Sponsor followed by ### Supporters heading");
    // ### Supporters moved under another H2 section instead of ## Sponsor
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        [
          "[![Sponsors](https://img.shields.io/github/sponsors/AquilaXk?style=flat-square)](https://github.com/sponsors/AquilaXk)",
          "## Sponsor",
          "[github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk).",
          "## Disclaimer",
          "### Supporters",
          "[become a sponsor](https://github.com/sponsors/AquilaXk).",
        ].join("\n"),
      ),
    ).toContain("README.md is missing ## Sponsor followed by ### Supporters heading");
    // 3 total links, but ### Supporters itself has no sponsor link
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        [
          "[![Sponsors](https://img.shields.io/github/sponsors/AquilaXk?style=flat-square)](https://github.com/sponsors/AquilaXk)",
          "## Sponsor",
          "[github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk) · [sponsor](https://github.com/sponsors/AquilaXk).",
          "### Supporters",
          "Your name here.",
        ].join("\n"),
      ),
    ).toContain("README.md must link to https://github.com/sponsors/AquilaXk in badge, Sponsor, and Supporters sections");
    // Visible schemeless github.com/sponsors/<handle> text disagrees with href
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme.replace("[github.com/sponsors/AquilaXk]", "[github.com/sponsors/OtherSponsor]"),
      ),
    ).toEqual(["README.md links to mismatched GitHub Sponsors handle: OtherSponsor"]);
    // Locale README extra/mismatched handle caught even when primary URL is also present
    expect(
      validateRepositoryFundingMetadata(
        "github: [AquilaXk]\n",
        validPkg,
        validReadme,
        {
          "readme/README.ko.md": validLocaleReadme.replace(
            "[후원하기](https://github.com/sponsors/AquilaXk)",
            "[후원하기](https://github.com/sponsors/OtherSponsor)",
          ),
        },
      ),
    ).toEqual(["readme/README.ko.md links to mismatched GitHub Sponsors handle: OtherSponsor"]);
  });

  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("Windows-capable release workflow steps with bash syntax declare shell: bash", () => {
    interface WorkflowStep {
      name?: string;
      if?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
    }
    interface WorkflowJob {
      "runs-on"?: string;
      strategy?: { matrix?: { include?: Array<{ os?: string }> } };
      steps?: WorkflowStep[];
    }
    const parsed = Bun.YAML.parse(readText(".github/workflows/release.yml")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const violations: string[] = [];
    for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
      const matrixOs = (job.strategy?.matrix?.include ?? []).map(row => row.os);
      const canRunOnWindows = job["runs-on"] === "windows-latest" || matrixOs.includes("windows-latest");
      if (!canRunOnWindows) continue;
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        const usesBash = step.run.includes("set -euo pipefail") || step.run.includes("[[ ");
        const nonWindowsOnly =
          typeof step.if === "string"
          && (step.if.includes("runner.os == 'macOS'") || step.if.includes("runner.os == 'Linux'"));
        if (usesBash && !nonWindowsOnly && step.shell !== "bash") {
          violations.push(`${jobId}:${step.name ?? "(unnamed)"}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("desktop release bundling unsets empty signing env vars and sets PATCHELF for AppImage", () => {
    interface WorkflowStep {
      name?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
    }
    const parsed = Bun.YAML.parse(readText(".github/workflows/release.yml")) as {
      jobs?: Record<string, { steps?: WorkflowStep[] }>;
    };
    const desktopSteps = parsed.jobs?.["package-desktop"]?.steps ?? [];
    const buildDesktop = desktopSteps.find(step => step.name === "Build desktop bundles");
    expect(buildDesktop?.shell).toBe("bash");
    expect(buildDesktop?.run).toContain('unset "$v"');
    for (const key of ["APPLE_CERTIFICATE", "APPLE_ID", "TAURI_SIGNING_PRIVATE_KEY"]) {
      expect(buildDesktop?.run).toContain(key);
    }

    const appImage = desktopSteps.find(step => step.name === "Build Linux AppImage bundle");
    expect(appImage?.env?.PATCHELF).toBe("${{ github.workspace }}/desktop/scripts/appimage-patchelf.py");
    expect(appImage?.run).toContain('unset "$v"');
    expect(appImage?.run).toContain("TAURI_SIGNING_PRIVATE_KEY");

    const deb = desktopSteps.find(step => step.name === "Build Linux deb bundle");
    expect(deb?.run).toContain('unset "$v"');
    expect(deb?.run).toContain("TAURI_SIGNING_PRIVATE_KEY");
  });

  test.skipIf(process.platform === "win32")("appimage-patchelf preserves prepared epx sidecar bytes under CARGO_TARGET_DIR", () => {
    const work = mkdtempSync(join(tmpdir(), "epx-patchelf-"));
    tempDirs.push(work);
    const fakeRepo = join(work, "repo");
    const scriptDst = join(fakeRepo, "desktop", "scripts", "appimage-patchelf.py");
    const binariesDir = join(fakeRepo, "desktop", "src-tauri", "binaries");
    const preparedEpx = join(binariesDir, "epx-x86_64-unknown-linux-gnu");
    const cargoTargetDir = join(work, "appimage-target");
    const appDirBin = join(
      cargoTargetDir,
      "x86_64-unknown-linux-gnu",
      "release",
      "bundle",
      "appimage",
      "EasyProxy.AppDir",
      "usr",
      "bin",
    );
    const appDirEpx = join(appDirBin, "epx");

    mkdirSync(join(fakeRepo, "desktop", "scripts"), { recursive: true });
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(appDirBin, { recursive: true });
    copyFileSync(repoPath("desktop", "scripts", "appimage-patchelf.py"), scriptDst);
    chmodSync(scriptDst, 0o755);

    const payload = Buffer.from("\x7fELF-fake-bun-sidecar-and-js-trailer");
    writeFileSync(preparedEpx, payload);
    writeFileSync(appDirEpx, payload);

    const res = spawnSync(
      scriptDst,
      ["--set-rpath", "$ORIGIN/../lib", appDirEpx],
      {
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Preserving compiled epx bytes");
    expect(readFileSync(appDirEpx)).toEqual(payload);
  });

  test.skipIf(process.platform === "win32")("verify-linux-sidecar resolves relative bundle directory before entering scratch dir", () => {
    const work = mkdtempSync(join(tmpdir(), "epx-sidecar-rel-"));
    tempDirs.push(work);
    const fakeRepo = join(work, "repo");
    const fakeBin = join(work, "bin");
    const scriptDst = join(fakeRepo, "desktop", "scripts", "verify-linux-sidecar.sh");
    const binariesDir = join(fakeRepo, "desktop", "src-tauri", "binaries");
    const preparedEpx = join(binariesDir, "epx-x86_64-unknown-linux-gnu");
    const relBundleDir = join(fakeRepo, "rel-appimage");
    const mockAppImage = join(relBundleDir, "EasyProxy_0.1.0_amd64.AppImage");
    const fixtureRoot = join(work, "extracted-fixture");
    const fixtureBin = join(fixtureRoot, "usr", "bin", "epx");
    const fixtureKeyring = join(fixtureRoot, "usr", "lib", "EasyProxy", "keyring", "keyring.linux-x64-gnu.node");
    const fixtureNativeDir = join(fixtureRoot, "usr", "lib", "EasyProxy", "native-bin", "linux-x64");
    const fixtureChild = join(fixtureNativeDir, "epx-child");

    mkdirSync(join(fakeRepo, "desktop", "scripts"), { recursive: true });
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(relBundleDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(fixtureRoot, "usr", "bin"), { recursive: true });
    mkdirSync(join(fixtureRoot, "usr", "lib", "EasyProxy", "keyring"), { recursive: true });
    mkdirSync(fixtureNativeDir, { recursive: true });

    copyFileSync(repoPath("desktop", "scripts", "verify-linux-sidecar.sh"), scriptDst);
    chmodSync(scriptDst, 0o755);

    const epxScript = "#!/usr/bin/env bash\nif [ \"${1:-}\" = \"--version\" ]; then\n  echo \"0.1.0\"\n  exit 0\nfi\nif [ \"${1:-}\" = \"__keyring-load-check\" ]; then\n  echo '{\"schema\":\"epx-keyring-load/1\",\"available\":true}'\n  exit 0\nfi\nexit 1\n";
    writeFileSync(preparedEpx, epxScript);
    chmodSync(preparedEpx, 0o755);
    writeFileSync(fixtureBin, epxScript);
    chmodSync(fixtureBin, 0o755);
    writeFileSync(fixtureKeyring, "addon");
    const childBytes = Buffer.from("#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(fixtureChild, childBytes);
    chmodSync(fixtureChild, 0o755);
    const childHash = createHash("sha256").update(childBytes).digest("hex");
    writeFileSync(join(fixtureNativeDir, "SHA256SUMS"), `${childHash}  epx-child\n`);

    writeFileSync(
      mockAppImage,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [ "\${1:-}" = "--appimage-extract" ]; then\n  cp -R "${fixtureRoot}" ./squashfs-root\n  exit 0\nfi\nexit 1\n`,
    );
    chmodSync(mockAppImage, 0o755);

    const timeoutShim = join(fakeBin, "timeout");
    writeFileSync(timeoutShim, "#!/usr/bin/env bash\nshift\nexec \"$@\"\n");
    chmodSync(timeoutShim, 0o755);

    const shaShim = join(fakeBin, "sha256sum");
    writeFileSync(
      shaShim,
      "#!/usr/bin/env python3\nimport hashlib, pathlib, sys\nif sys.argv[1:] == ['-c', 'SHA256SUMS']:\n  for line in pathlib.Path('SHA256SUMS').read_text().splitlines():\n    digest, name = line.split(None, 1)\n    actual = hashlib.sha256(pathlib.Path(name.strip()).read_bytes()).hexdigest()\n    assert actual == digest, f'{actual} != {digest}'\nelse:\n  for path in sys.argv[1:]:\n    print(f\"{hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()}  {path}\")\n",
    );
    chmodSync(shaShim, 0o755);

    const res = spawnSync("bash", ["desktop/scripts/verify-linux-sidecar.sh", "rel-appimage"], {
      cwd: fakeRepo,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
  });

  test.skipIf(process.platform === "win32")("appimage-patchelf preserves prepared native-bin helpers and fails closed on symlinks", () => {
    const work = mkdtempSync(join(tmpdir(), "epx-patchelf-native-"));
    tempDirs.push(work);
    const fakeRepo = join(work, "repo");
    const scriptDst = join(fakeRepo, "desktop", "scripts", "appimage-patchelf.py");
    const preparedDir = join(fakeRepo, "desktop", "src-tauri", "resources", "native-bin", "linux-x64");
    const preparedChild = join(preparedDir, "epx-child");
    const cargoTargetDir = join(work, "appimage-target");
    const appDirNative = join(
      cargoTargetDir,
      "x86_64-unknown-linux-gnu",
      "release",
      "bundle",
      "appimage",
      "EasyProxy.AppDir",
      "usr",
      "lib",
      "EasyProxy",
      "native-bin",
      "linux-x64",
    );
    const appDirChild = join(appDirNative, "epx-child");

    mkdirSync(join(fakeRepo, "desktop", "scripts"), { recursive: true });
    mkdirSync(preparedDir, { recursive: true });
    mkdirSync(appDirNative, { recursive: true });
    copyFileSync(repoPath("desktop", "scripts", "appimage-patchelf.py"), scriptDst);
    chmodSync(scriptDst, 0o755);

    const payload = Buffer.from("\x7fELF-fake-rust-epx-child-binary");
    const expectedHash = createHash("sha256").update(payload).digest("hex");
    writeFileSync(preparedChild, payload);
    writeFileSync(appDirChild, payload);

    for (let pass = 0; pass < 2; pass += 1) {
      const res = spawnSync(
        scriptDst,
        ["--set-rpath", "$ORIGIN", appDirChild],
        {
          env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
          encoding: "utf8",
        },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("Preserving prepared native helper epx-child bytes");
      expect(readFileSync(appDirChild)).toEqual(payload);
      expect(createHash("sha256").update(readFileSync(appDirChild)).digest("hex")).toBe(expectedHash);
    }

    rmSync(appDirChild);
    symlinkSync(preparedChild, appDirChild);
    const symlinkRes = spawnSync(
      scriptDst,
      ["--set-rpath", "$ORIGIN", appDirChild],
      {
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
        encoding: "utf8",
      },
    );
    expect(symlinkRes.status).not.toBe(0);
    expect(symlinkRes.stderr).toContain("AppImage native helper differs from the prepared binary");
  });
});
