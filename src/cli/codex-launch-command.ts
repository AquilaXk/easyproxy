import { extname, win32 } from "node:path";
import { readBoundedProjectConfig } from "../codex/project-config-warnings";
import { buildWindowsCodexShim, SHIM_MARKER } from "../codex/shim-templates";
import type { BunRuntimeSource } from "../lib/bun-runtime";

export const CODEX_UNVERIFIED_SHIM = "easyproxy: cannot verify Codex shim bypass; launch refused. Run 'epx codex-shim install' to refresh an obsolete shim, or select the native Codex executable.";

/** A content check for the generated CMD control flow, not Windows backing-file provenance. */
export function codexCommandCanBypass(selected: string, env: Record<string, string | undefined>, platform = process.platform): boolean {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extname(selected).toLowerCase())) return true;
  const content = readBoundedProjectConfig(selected);
  if (content === null) return false;
  // Ordinary npm launchers remain ordinary executable code. Managed/obsolete wrappers must
  // prove the whole emitted control flow, including the unique terminal bypass destination.
  if (!content.includes(SHIM_MARKER) && !/EPX_|EASYPROXY_API_AUTH_TOKEN|service-api-token/i.test(content)) return true;
  const source = /^set "EPX_BUN_RUNTIME_SOURCE=(override|bundled|process|standalone)"\r?$/m.exec(content)?.[1] as BunRuntimeSource | undefined;
  if (!source) return false;
  const normalize = (text: string): string | null => {
    let invalid = false;
    const normalized = text.replace(/\r\n/g, "\n").replace(/^set "(EPX_REAL_CODEX|EPX_BUN|EPX_CLI|EPX_API_TOKEN_FILE|EPX_BUN_RUNTIME_PATH)=([^"\n]*)"$/gm, (_line, key: string, raw: string) => {
      const expanded = raw.replace(/^%(USERPROFILE|LOCALAPPDATA|APPDATA)%/i, (_prefix, variable: string) => env[variable.toUpperCase()] ?? "");
      // Restrict substitutions to literal local paths. Refuse CMD expansion, separators,
      // delayed expansion and control bytes rather than interpreting batch escaping.
      if (!/^[a-z]:[\\/]/i.test(expanded) || !win32.isAbsolute(expanded) || /[%!^&|<>"\x00-\x1f\x7f]/.test(expanded)) invalid = true;
      return `set "${key}=<local-path>"`;
    });
    return invalid ? null : normalized;
  };
  const expected = buildWindowsCodexShim("C:\\epx\\codex.cmd", "C:\\epx\\bun.exe", "C:\\epx\\cli.ts", source);
  const actual = normalize(content);
  return actual !== null && actual === normalize(expected);
}
