import type { UpdateJobState } from "./job-types";

export const RELEASE_NOTES_URL = "https://github.com/AquilaXk/easyproxy/releases/latest";

/**
 * Recognized npm/libc error codes, as an explicit set.
 *
 * A shape pattern like `E[A-Z]{3,}` is NOT a vocabulary: `C:\Users\ERROR\.npm` matches it, and
 * the summary then re-emits the username the withheld output was protecting. Only codes on this
 * list are surfaced, and only when they appear in npm's canonical `code <CODE>` position.
 */
const NPM_ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "EEXIST", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE",
  "ENOSPC", "EROFS", "EXDEV", "ELOOP", "ENAMETOOLONG", "ENOTEMPTY", "EBUSY",
  "EAGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EPROTO", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "E401", "E403", "E404", "E409", "E429", "E500", "E503",
  "EINTEGRITY", "ERESOLVE", "ETARGET", "EPUBLISHCONFLICT", "ENEEDAUTH",
  "EUSAGE", "EJSONPARSE", "EOTP", "EINVALIDTYPE", "ELIFECYCLE",
  "ERR_SOCKET_TIMEOUT", "ERR_INVALID_ARG_TYPE", "ERR_MODULE_NOT_FOUND",
]);

/**
 * npm's failure output is STRUCTURED, not prose: `npm error <field> <value>`, one field per
 * line (`npm ERR!` on npm 9 and earlier). That is what makes a useful summary possible without
 * reproducing text — we can read named fields and keep the ones whose value cannot be a path.
 *
 * Fields kept, with a real example of each:
 *   code     E404, EACCES, ETARGET      the single most useful line for diagnosis
 *   syscall  mkdir, open, getaddrinfo   what npm was doing
 *   errno    -13                        the OS errno
 *   notarget No matching version ...    version-resolution explanation, no path
 *   404      404 Not Found - GET <url>  registry URL, no local path
 *
 * Deliberately NOT kept: `path`, `dest`, `file`, `stack`, and the bare `Error: ...` line —
 * every one of those is a filesystem path by definition. `A complete log of this run can be
 * found in: <path>` is dropped for the same reason.
 */
const NPM_FIELD_LINE = /^\s*npm\s+(?:error|ERR!)\s+([a-z0-9]+)\s+(.*)$/gim;

/**
 * POSIX syscall names npm actually reports. An explicit vocabulary, not a shape.
 *
 * `^[a-z][a-z0-9_]{1,20}$` accepts `janedoe`, which is the whole problem: allowlisting the
 * FIELD NAME while leaving its VALUE free-form just moves the leak one level in.
 */
const POSIX_SYSCALLS = new Set([
  "open", "openat", "close", "read", "write", "stat", "lstat", "fstat", "mkdir", "rmdir",
  "unlink", "rename", "symlink", "readlink", "link", "chmod", "chown", "utimes", "access",
  "scandir", "readdir", "copyfile", "realpath", "futime", "ftruncate", "fchmod", "fchown",
  "connect", "getaddrinfo", "getnameinfo", "socket", "bind", "listen", "accept", "send",
  "recv", "shutdown", "spawn", "spawnSync", "kill", "watch", "lchown", "lutimes", "mkdtemp",
]);

/** Per-field value contracts. A field is only kept when its value satisfies its own rule. */
const KNOWN_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  "npm.pkg.github.com",
]);

const NPM_FIELD_VALIDATORS: Record<string, (value: string) => string | null> = {
  // A recognized code, nothing else.
  code: value => (NPM_ERROR_CODES.has(value) ? value : null),
  // A known syscall name, nothing else.
  syscall: value => (POSIX_SYSCALLS.has(value) ? value : null),
  // An integer, rendered from the parsed number so the original string never passes through.
  errno: value => (/^-?\d{1,10}$/.test(value) ? String(Number(value)) : null),
  // Version resolution: the FACT only.
  //
  // Two narrowing attempts failed here and the second is the instructive one. Extracting any
  // `name@version` also matched `jane.doe@example.com`. Pinning the NAME to our own package
  // still left the VERSION free: `easyproxy@99.99.99-JaneDoe` is a valid-looking
  // spec, and a semver prerelease identifier can encode anything — the same lesson the
  // `/healthz` version taught in round 13.
  //
  // There is no trusted resolved version available at this call site, so the spec is not
  // rendered at all. `code: ETARGET` plus this fact already tells a user their requested
  // version does not exist, which is the diagnostic that matters.
  notarget: () => "no matching version",
};

/**
 * Describe external text without reproducing it.
 *
 * Use this wherever an `Error.message`, a vendor stream, or any string this module did not
 * compose would otherwise be interpolated into a persisted field. The result names the error's
 * TYPE and size — enough to tell a reader what class of failure occurred — and never its text,
 * which is where the paths and account names live.
 */
export function withheldSummary(error: unknown): string {
  // `error.name` is writable, so it is external text like the message. A fixed classification
  // is the only part of an unknown error we can state without repeating something we were
  // handed: `new Error(...)` with `error.name = "Jane Doe"` was persisting the name verbatim.
  const name = error instanceof Error ? "Error" : typeof error;
  // NO MESSAGE TEXT, ever. An earlier version kept messages that carried no path, which sounds
  // reasonable and is wrong: `spawn denied for Jane Doe` has no path in it and still names a
  // person. There is no test on message CONTENT that separates a diagnostic from an identity,
  // so the message does not cross this boundary at all.
  const code = (error as { code?: unknown } | null)?.code;
  // Only recognized codes — an arbitrary uppercase `error.code` can be attacker-shaped too.
  const codeNote = typeof code === "string" && NPM_ERROR_CODES.has(code) ? ` ${code}` : "";
  const text = error instanceof Error ? error.message : String(error ?? "");
  // Node's own errors are structured the same way npm's output is: `syscall` and `errno` are
  // named properties, not prose. Reading those gives a user the actual cause —
  // `Error EACCES · syscall: mkdir · errno: -13` — without repeating a message that could name
  // a person or a path. Both are shape-validated: a syscall is a short lowercase identifier and
  // an errno is an integer, so neither can carry arbitrary text.
  const parts = [`${name}${codeNote}`];
  const syscall = (error as { syscall?: unknown } | null)?.syscall;
  // Same explicit vocabulary as the npm field: a shape check accepts `janedoe`.
  if (typeof syscall === "string" && POSIX_SYSCALLS.has(syscall)) parts.push(`syscall: ${syscall}`);
  const errno = (error as { errno?: unknown } | null)?.errno;
  if (typeof errno === "number" && Number.isInteger(errno)) parts.push(`errno: ${errno}`);
  parts.push(`${Buffer.byteLength(text, "utf8")} bytes withheld`);
  return parts.join(" · ");
}

/** Absolute paths cannot appear in text this module composed; if one does, it came from outside. */
function withholdIfPathBearing(value: string): string {
  const pathBearing = /[A-Za-z]:[\\/]/.test(value)          // C:\ or C:/
    || /\\\\/.test(value)                                    // \\server\share
    || /\\/.test(value)                                      // any backslash
    || /~[\w.-]*\//.test(value)                              // ~/ or ~user/ anywhere
    || /[%$][A-Za-z_]/.test(value)                           // %APPDATA%, $HOME
    || /\/[\w.\-~%]+\//.test(value)                          // any two-segment path run
    || /\b(?:Users|home|Documents and Settings|AppData|Profiles)\b/i.test(value)
    || /\r?\n/.test(value);                                  // multi-line vendor output
  if (!pathBearing) return value;
  return `<withheld: ${Buffer.byteLength(value, "utf8")} bytes, may contain local paths>`;
}

/**
 * Keep a command readable without persisting the launcher path it contains.
 *
 * The real npm worker command is `node /Users/<name>/.../bin/epx.mjs update --tag latest`, so
 * the account name is inside it by construction. Absolute path arguments are replaced with a
 * placeholder and everything else — the binary name, the flags, the tag — is kept, which is the
 * part a reader actually needs.
 */
function renderSafeCommand(value: string): string {
  if (!value) return value;
  // Rebuild from a recognized shape rather than filtering the string we were handed. Content
  // cannot distinguish `npm install Mary-Jane` — an account name — from a legitimate package
  // argument, so anything that is not this exact shape is withheld by the caller's path test.
  const parts = value.trim().split(/\s+/);
  const tool = parts[0] === "$" ? parts[1] : parts[0];
  if (tool !== undefined && /^(?:npm|bun|pnpm|yarn|node)$/.test(tool)) {
    const rendered = parts.map(part =>
      /^(?:[A-Za-z]:[\\/]|[\\/]|~|\\\\)/.test(part) ? "<path>" : part);
    // Only fixed flags, our own package spec, and placeholders survive; a bare word that is not
    // one of those is treated as unknown input and the whole value is withheld.
    const allowed = rendered.every(part =>
      part === "$" || part === "<path>"
      || /^(?:npm|bun|pnpm|yarn|node)$/.test(part)
      || /^-{1,2}[\w-]+$/.test(part)
      || /^(?:install|add|update|i)$/.test(part)
      || /^easyproxy(?:@[\w.\-]+)?$/.test(part)
      || /^(?:latest|preview|next|beta)$/.test(part)
      || /^\d[\w.\-]*$/.test(part));
    if (allowed) return rendered.join(" ");
  }
  return `<withheld: ${Buffer.byteLength(value, "utf8")} bytes, unrecognized command shape>`;
}

/**
 * Decide, per field, whether the value is ours to keep.
 *
 * `log` and `error` are composed from this module's own templates; every place that would have
 * interpolated external text now calls `withheldSummary()` first, so the strings arriving here
 * are ours by construction. `releaseNotesUrl` is compared against the module constant rather
 * than pattern-matched, which is what stops a URL-shaped value from smuggling a path.
 * `command` is rendered from validated parts.
 */
function brandOwnComposedText(key: string, value: unknown): unknown {
  if (key === "releaseNotesUrl") {
    return value === RELEASE_NOTES_URL ? value : "";
  }
  if (key === "command") {
    // Render the command shape first, then apply the same path test as every other field. The
    // renderer only understands space-separated arguments; anything else reaching this field is
    // not a command we built and must not be trusted because of where it was stored.
    return typeof value === "string" ? withholdIfPathBearing(renderSafeCommand(value)) : value;
  }
  // `log` and `error` are ours by construction, but a caller can still slip external text in by
  // interpolating it. Withhold any value that carries an absolute path of any form — that is a
  // narrow, unambiguous test on strings we already control, not the free-text classification
  // that failed nine times.
  if (typeof value === "string") return withholdIfPathBearing(value);
  if (Array.isArray(value)) return value.map(item => (typeof item === "string" ? withholdIfPathBearing(item) : item));
  return value;
}

/**
 * Fields that can carry free-form text and therefore need checking at the write boundary.
 *
 * The rest of the record is a closed vocabulary — statuses, channels, installers, versions, an
 * id, timestamps — so checking it only risks mangling values that were never a disclosure
 * route. Naming the risky fields keeps the boundary narrow and auditable.
 */
const FREE_TEXT_JOB_FIELDS = new Set(["command", "error", "log", "releaseNotesUrl"]);

/** Apply the per-field rule at the single point where a job reaches disk. */
export function sanitizePersistedUpdateJob(job: UpdateJobState): UpdateJobState {
  return Object.fromEntries(
    Object.entries(job).map(([key, item]) => [
      key,
      FREE_TEXT_JOB_FIELDS.has(key) ? brandOwnComposedText(key, item) : item,
    ]),
  ) as UpdateJobState;
}

/**
 * HTTP status lines carry a registry URL. Render it from parsed parts rather than echoing the
 * line: a URL can embed userinfo (`https://Jane:pw@host/`) or a path, and the raw text also
 * defeats the path test because `https:/` looks like a drive letter.
 */
function npmHttpStatusValue(field: string, value: string): string | null {
  const url = /\bhttps?:\/\/[^\s]+/.exec(value)?.[0];
  if (!url) return `HTTP ${field}`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return `HTTP ${field}`; }
  // Only hosts we can name in advance. A shape check (`^[\w.-]+$`) accepts
  // `janedoe.example`, a numeric host, or a punycode host — an arbitrary hostname is a
  // disclosure channel, not a diagnostic. Knowing it was the public registry versus "some
  // other host" is the part that helps, and that fits in an allowlist.
  return KNOWN_REGISTRY_HOSTS.has(parsed.hostname.toLowerCase()) && !parsed.username && !parsed.password
    ? `HTTP ${field} from ${parsed.hostname.toLowerCase()}`
    : `HTTP ${field}`;
}

/**
 * Extract the diagnostic fields npm names explicitly.
 *
 * Each kept value still passes `withholdIfPathBearing` before it is used: a registry URL is
 * fine, but `syscall` and friends are only safe by convention, and a convention is not a
 * guarantee. Values are length-capped so a hostile responder cannot pad the record.
 */
function npmDiagnosticFields(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(NPM_FIELD_LINE)) {
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (seen.has(field) || !value || value.length > 160) continue;
    // Every kept field is RENDERED from a validated value, never echoed. Allowlisting the field
    // name alone left the value free-form, so `npm error syscall janedoe` walked straight
    // through — the field was recognized and the value was never checked against anything.
    const validate = NPM_FIELD_VALIDATORS[field];
    const rendered = validate
      ? validate(value)
      : (/^(?:404|401|403|409|429)$/.test(field) ? npmHttpStatusValue(field, value) : null);
    if (rendered === null) continue;
    seen.set(field, rendered);
  }
  return [...seen].map(([field, value]) => `${field}: ${value}`);
}

/**
 * Build a structured, path-free summary of a command's result.
 *
 * Only three things cross the boundary: how the process ended, how much it printed, and any
 * recognized error codes. None of those can carry a filesystem path or an account name.
 */
export function summarizeCommandOutput(
  stdout: string,
  stderr: string,
  status: number | null,
  signal: NodeJS.Signals | null,
): string | null {
  if (!stdout && !stderr && status === 0) return null;

  const parts: string[] = [];
  parts.push(signal ? `terminated by ${signal}` : `exit ${status ?? "null"}`);

  // Read npm's own named fields rather than reproducing its text — `code: E404 ·
  // 404: ...` tells a user exactly what happened and none of it can be a local path.
  const fields = npmDiagnosticFields(`${stderr}\n${stdout}`);
  if (fields.length > 0) parts.push(...fields);

  const bytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
  if (bytes > 0) {
    parts.push(fields.length > 0
      ? `${bytes} bytes of full output withheld`
      : `${bytes} bytes of output withheld (no recognized diagnostic fields)`);
  }

  return parts.join(" · ");
}
