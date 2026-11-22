import { existsSync, readFileSync } from "node:fs";

type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|ps1|sh|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

function gitLsFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ls-files failed: ${stderr.trim() || result.exitCode}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean);
}

function shouldScan(file: string): boolean {
  if (!TEXT_FILE_RE.test(file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  if (EXCLUDED_SUFFIXES.some(suffix => file.endsWith(suffix))) return false;
  return true;
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  if (domain === "example.test" || domain === "example.com" || domain === "test.com" || domain.endsWith(".test")) {
    return true;
  }
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  if (/^(?:[a-z]+_)?\d+x\d+@[23]x\.(?:png|jpe?g|gif|webp|tiff?)$/i.test(email)) return true;
  return file.startsWith("tests/") && email === "a@b.com";
}

function isAllowedHomePath(file: string, username: string): boolean {
  if (file.startsWith("tests/") && (username === "example" || username === "test" || username === "x")) {
    return true;
  }
  if (file.startsWith("docs-site/") && username === "example") return true;
  return false;
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  if (file.startsWith("tests/")) {
    return /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token);
  }
  return false;
}

function isAllowedBearerToken(file: string, token: string): boolean {
  if (!file.startsWith("tests/")) return false;
  return /^(?:access|stack|usage-debug)-token(?:-value)?-[A-Za-z0-9-]+$/.test(token);
}

function isPlaceholderToken(token: string): boolean {
  if (/^(?:[@:/._-]*%[hpr])+[@:/._-]*$/.test(token)) return true;
  if (/^<[^<>]*>$/.test(token)) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token)) return true;
  if (/^\{+[^{}]*\}*$/.test(token)) return true;
  if (/^[}>]+$/.test(token)) return true;
  const host = (token.split("@").at(-1) ?? "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (/^(?:localhost|example|invalid|test|example\.(?:com|net|org))$/i.test(host)) return true;
  if (/\.(?:localhost|example|invalid|test|example\.(?:com|net|org))$/i.test(host)) return true;
  return /^(?:user|username|me|you|someone|root|ubuntu|runner)$/i.test(token);
}

function isAllowedSshEndpoint(value: string): boolean {
  const v = value.replace(/(?:^|[ \t])#.*$/, "").trim();
  if (!v) return true;
  return v.split(/[ \t]+/).every(isPlaceholderToken);
}

function addFindingsForPattern(
  findings: Finding[],
  file: string,
  text: string,
  kind: string,
  pattern: RegExp,
  allow: (match: RegExpExecArray) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (allow(match)) continue;
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind,
      value: match[0],
    });
  }
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  addFindingsForPattern(
    findings,
    file,
    text,
    "home-path",
    /\/Users\/([A-Za-z0-9_-]+)\//g,
    match => isAllowedHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "email",
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    match => isAllowedEmail(file, match[0]),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "bearer-token",
    /Bearer\s+([A-Za-z0-9._-]{24,})/g,
    match => isAllowedBearerToken(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "token-looking",
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "ssh-endpoint",
    /^[ \t]*HostName[ \t]+(\S+)(?:[ \t]+#[^\n]*)?[ \t]*$/gim,
    match => isAllowedSshEndpoint(match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "ssh-proxy-command",
    /^[ \t]*ProxyCommand[ \t=]+(\S.*)$/gim,
    match => isAllowedSshEndpoint(match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "meta-api-key",
    /\bLLM\|\d+\|[A-Za-z0-9_-]{10,}\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  return findings;
}

function scanFile(file: string): Finding[] {
  return scanText(file, readFileSync(file, "utf-8"));
}

const REDACTED_FINDING_KINDS = new Set([
  "bearer-token",
  "token-looking",
  "meta-api-key",
  "ssh-proxy-command",
  "ssh-endpoint",
]);

if (import.meta.main) {
  runScan();
}

function runScan(): void {
  const findings = gitLsFiles()
    .filter(existsSync)
    .filter(shouldScan)
    .flatMap(scanFile);

  if (findings.length > 0) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      const shown = REDACTED_FINDING_KINDS.has(finding.kind) ? "<redacted>" : finding.value;
      console.error(`${finding.file}:${finding.line} ${finding.kind}: ${shown}`);
    }
    process.exit(1);
  }

  console.log("Privacy scan passed");
}
