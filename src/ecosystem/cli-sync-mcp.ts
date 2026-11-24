import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { PARSE_FAILED, parseConfig } from "../integrations/config-io";
import { serializeDocument, type ConfigFormat } from "../integrations/serialize";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";

export const ECOSYSTEM_CLI_IDS = ["claude", "codex", "gemini", "opencode"] as const;
export type EcosystemCliId = (typeof ECOSYSTEM_CLI_IDS)[number];

export const ECOSYSTEM_SYNC_KINDS = ["mcp", "skills"] as const;
export type EcosystemSyncKind = (typeof ECOSYSTEM_SYNC_KINDS)[number];

export const MAX_ECOSYSTEM_CONFIG_BYTES = 4 * 1024 * 1024;
export const MAX_ECOSYSTEM_MCP_SERVERS = 128;

export class EcosystemSyncError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "ecosystem_sync_error",
  ) {
    super(message);
    this.name = "EcosystemSyncError";
  }
}

export interface NormalizedMcpServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  envKeys: string[];
  env?: Record<string, string>;
  url?: string;
  headerKeys: string[];
  headers?: Record<string, string>;
  disabled?: boolean;
  digest: string;
}

export interface RedactedMcpServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  envKeys: string[];
  url?: string;
  headerKeys: string[];
  disabled?: boolean;
  digest: string;
}

export interface UnsupportedMcpEntry {
  name: string;
  reason: string;
}

export interface ParsedCliMcpConfig {
  exists: boolean;
  format: ConfigFormat;
  document: Record<string, unknown>;
  servers: Map<string, NormalizedMcpServer>;
  unsupported: UnsupportedMcpEntry[];
  warnings: string[];
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const val = value[key];
    if (typeof val !== "string") return null;
    out[key] = val;
  }
  return out;
}

function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function computeServerDigest(server: Omit<NormalizedMcpServer, "digest">): string {
  const canonical = {
    name: server.name,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    url: server.url ?? null,
    headers: server.headers ?? {},
    disabled: Boolean(server.disabled),
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function sanitizeMcpUrlForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    if (parsed.search) {
      const redactedParams = new URLSearchParams();
      for (const [key] of parsed.searchParams) {
        redactedParams.append(key, "***");
      }
      parsed.search = `?${redactedParams.toString()}`;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl
      .replace(/#.*$/, "")
      .replace(/\?.*$/, "")
      .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, "$1***@");
  }
}

export function redactMcpServer(server: NormalizedMcpServer): RedactedMcpServer {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: [...server.args] } : {}),
    envKeys: [...server.envKeys],
    ...(server.url !== undefined ? { url: sanitizeMcpUrlForDisplay(server.url) } : {}),
    headerKeys: [...server.headerKeys],
    ...(server.disabled !== undefined ? { disabled: server.disabled } : {}),
    digest: server.digest,
  };
}

export function readBoundedNonSymlinkFile(path: string, maxBytes: number, label: string): Buffer | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return null;
    throw new EcosystemSyncError(`Cannot inspect ${label}: ${(error as Error).message}`, 400, "ecosystem_io_error");
  }
  if (stat.isSymbolicLink()) {
    throw new EcosystemSyncError(`Refusing symlinked ${label}`, 400, "ecosystem_symlink_refused");
  }
  if (!stat.isFile()) {
    throw new EcosystemSyncError(`Expected regular file for ${label}`, 400, "ecosystem_invalid_file");
  }
  try {
    return readBoundedRegularFileSync(path, maxBytes);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    if (message.includes("not bounded regular data") || message.includes("exceeds byte limit")) {
      throw new EcosystemSyncError(`${label} exceeds ${maxBytes} bytes limit`, 400, "ecosystem_limit_exceeded");
    }
    const code = (error as { code?: string })?.code;
    if (code === "ELOOP" || message.includes("not a regular file")) {
      throw new EcosystemSyncError(`Refusing symlinked ${label}`, 400, "ecosystem_symlink_refused");
    }
    throw new EcosystemSyncError(`Failed to read ${label}: ${message}`, 400, "ecosystem_io_error");
  }
}

function formatForCli(cli: EcosystemCliId): ConfigFormat {
  return cli === "codex" ? "toml" : "json";
}

function mcpMapKeyForCli(cli: EcosystemCliId): string {
  if (cli === "codex") return "mcp_servers";
  if (cli === "opencode") return "mcp";
  return "mcpServers";
}

function normalizeServerEntry(
  cli: EcosystemCliId,
  name: string,
  entry: unknown,
): { server: NormalizedMcpServer } | { reason: string } {
  if (!isPlainRecord(entry)) {
    return { reason: "entry is not an object" };
  }

  if (cli === "opencode") {
    const disabled = entry.enabled === false ? true : undefined;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "local" || Array.isArray(entry.command)) {
      const cmdParts = toStringArray(entry.command);
      if (!cmdParts || cmdParts.length === 0 || !cmdParts[0]!.trim()) {
        return { reason: "local OpenCode MCP entry requires non-empty command array" };
      }
      const env = toStringRecord(entry.environment ?? entry.env);
      if (!env) return { reason: "environment must be a string record" };
      const envKeys = Object.keys(env);
      const base: Omit<NormalizedMcpServer, "digest"> = {
        name,
        transport: "stdio",
        command: cmdParts[0],
        ...(cmdParts.length > 1 ? { args: cmdParts.slice(1) } : {}),
        envKeys,
        ...(envKeys.length > 0 ? { env } : {}),
        headerKeys: [],
        ...(disabled ? { disabled } : {}),
      };
      return { server: { ...base, digest: computeServerDigest(base) } };
    }
    if (type === "remote" || typeof entry.url === "string") {
      if (typeof entry.url !== "string" || !entry.url.trim()) {
        return { reason: "remote OpenCode MCP entry requires url" };
      }
      const headers = toStringRecord(entry.headers);
      if (!headers) return { reason: "headers must be a string record" };
      const headerKeys = Object.keys(headers);
      const transport = entry.transport === "sse" ? "sse" : "http";
      const base: Omit<NormalizedMcpServer, "digest"> = {
        name,
        transport,
        url: entry.url,
        envKeys: [],
        headerKeys,
        ...(headerKeys.length > 0 ? { headers } : {}),
        ...(disabled ? { disabled } : {}),
      };
      return { server: { ...base, digest: computeServerDigest(base) } };
    }
    return { reason: "unsupported OpenCode MCP shape" };
  }

  const disabled = cli === "codex"
    ? (entry.enabled === false ? true : undefined)
    : (entry.disabled === true ? true : undefined);

  if (typeof entry.command === "string" && entry.command.trim()) {
    const args = toStringArray(entry.args);
    if (!args) return { reason: "args must be a string array" };
    const env = toStringRecord(entry.env);
    if (!env) return { reason: "env must be a string record" };
    const envKeys = Object.keys(env);
    const base: Omit<NormalizedMcpServer, "digest"> = {
      name,
      transport: "stdio",
      command: entry.command,
      ...(args.length > 0 ? { args } : {}),
      envKeys,
      ...(envKeys.length > 0 ? { env } : {}),
      headerKeys: [],
      ...(disabled ? { disabled } : {}),
    };
    return { server: { ...base, digest: computeServerDigest(base) } };
  }

  const remoteUrl = cli === "gemini"
    ? (typeof entry.httpUrl === "string" ? entry.httpUrl : typeof entry.url === "string" ? entry.url : undefined)
    : (typeof entry.url === "string" ? entry.url : undefined);
  if (typeof remoteUrl === "string" && remoteUrl.trim()) {
    const rawHeaders = cli === "codex" ? (entry.http_headers ?? entry.headers) : entry.headers;
    const headers = toStringRecord(rawHeaders);
    if (!headers) return { reason: "headers must be a string record" };
    const headerKeys = Object.keys(headers);
    let transport: "http" | "sse" = "http";
    if (entry.type === "sse") transport = "sse";
    else if (cli === "gemini" && typeof entry.httpUrl !== "string" && entry.type !== "http") {
      transport = "sse";
    }
    const base: Omit<NormalizedMcpServer, "digest"> = {
      name,
      transport,
      url: remoteUrl,
      envKeys: [],
      headerKeys,
      ...(headerKeys.length > 0 ? { headers } : {}),
      ...(disabled ? { disabled } : {}),
    };
    return { server: { ...base, digest: computeServerDigest(base) } };
  }

  return { reason: "entry has neither stdio command nor remote url" };
}

export function serializeServerForCli(cli: EcosystemCliId, server: NormalizedMcpServer): Record<string, unknown> {
  if (cli === "opencode") {
    if (server.transport === "stdio") {
      return {
        type: "local",
        command: [server.command!, ...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length > 0 ? { environment: { ...server.env } } : {}),
        enabled: !server.disabled,
      };
    }
    return {
      type: "remote",
      url: server.url!,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
      ...(server.transport === "sse" ? { transport: "sse" } : {}),
      enabled: !server.disabled,
    };
  }

  if (cli === "codex") {
    if (server.transport === "stdio") {
      return {
        command: server.command!,
        ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        ...(server.disabled ? { enabled: false } : {}),
      };
    }
    return {
      url: server.url!,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { http_headers: { ...server.headers } } : {}),
      ...(server.disabled ? { enabled: false } : {}),
    };
  }

  if (cli === "gemini") {
    if (server.transport === "stdio") {
      return {
        command: server.command!,
        ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        ...(server.disabled ? { disabled: true } : {}),
      };
    }
    return {
      ...(server.transport === "sse" ? { url: server.url! } : { httpUrl: server.url! }),
      ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
      ...(server.disabled ? { disabled: true } : {}),
    };
  }

  // claude
  if (server.transport === "stdio") {
    return {
      command: server.command!,
      ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      ...(server.disabled ? { disabled: true } : {}),
    };
  }
  return {
    type: server.transport === "sse" ? "sse" : "http",
    url: server.url!,
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
    ...(server.disabled ? { disabled: true } : {}),
  };
}

export function readCliMcpConfig(
  cli: EcosystemCliId,
  configPath: string,
  options: { strict?: boolean } = {},
): ParsedCliMcpConfig {
  const format = formatForCli(cli);
  const rawBuf = readBoundedNonSymlinkFile(configPath, MAX_ECOSYSTEM_CONFIG_BYTES, `${cli} MCP config`);
  if (rawBuf === null) {
    return {
      exists: false,
      format,
      document: {},
      servers: new Map(),
      unsupported: [],
      warnings: [],
    };
  }

  const parsed = parseConfig(rawBuf.toString("utf8"), format);
  if (parsed === PARSE_FAILED || !isPlainRecord(parsed)) {
    const message = `${cli} MCP config at ${configPath} is not a valid ${format.toUpperCase()} object`;
    if (options.strict) {
      throw new EcosystemSyncError(message, 400, "ecosystem_invalid_config");
    }
    return {
      exists: true,
      format,
      document: {},
      servers: new Map(),
      unsupported: [],
      warnings: [message],
    };
  }

  const mapKey = mcpMapKeyForCli(cli);
  const rawMap = parsed[mapKey];
  const servers = new Map<string, NormalizedMcpServer>();
  const unsupported: UnsupportedMcpEntry[] = [];
  const warnings: string[] = [];

  if (rawMap !== undefined) {
    if (!isPlainRecord(rawMap)) {
      const msg = `${cli} MCP field ${mapKey} is not an object`;
      if (options.strict) {
        throw new EcosystemSyncError(msg, 400, "ecosystem_invalid_config");
      }
      warnings.push(msg);
    } else {
      const names = Object.keys(rawMap);
      if (names.length > MAX_ECOSYSTEM_MCP_SERVERS) {
        throw new EcosystemSyncError(
          `${cli} MCP server count (${names.length}) exceeds limit of ${MAX_ECOSYSTEM_MCP_SERVERS}`,
          400,
          "ecosystem_limit_exceeded",
        );
      }
      for (const name of names.sort()) {
        const result = normalizeServerEntry(cli, name, rawMap[name]);
        if ("server" in result) {
          servers.set(name, result.server);
        } else {
          unsupported.push({ name, reason: result.reason });
        }
      }
    }
  }

  return {
    exists: true,
    format,
    document: parsed,
    servers,
    unsupported,
    warnings,
  };
}

export function buildMergedMcpConfigBytes(
  cli: EcosystemCliId,
  parsed: ParsedCliMcpConfig,
  updates: readonly NormalizedMcpServer[],
): string {
  const nextDoc = structuredClone(parsed.document);
  const mapKey = mcpMapKeyForCli(cli);
  const existingMap = isPlainRecord(nextDoc[mapKey]) ? { ...nextDoc[mapKey] } : {};
  for (const server of updates) {
    existingMap[server.name] = serializeServerForCli(cli, server);
  }
  nextDoc[mapKey] = existingMap;
  if (parsed.format === "toml") {
    return serializeDocument(nextDoc, "toml");
  }
  return `${JSON.stringify(nextDoc, null, 2)}\n`;
}
