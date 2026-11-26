import { execFileSync } from "node:child_process";

export const STABLE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface GitHubReleaseAssetSummary {
  id?: number;
  name: string;
  size: number;
  state: string;
  digest?: string | null;
  browser_download_url?: string;
}

export interface GitHubReleaseSummary {
  id?: number;
  tag_name: string;
  target_commitish?: string;
  draft: boolean;
  prerelease: boolean;
  assets?: GitHubReleaseAssetSummary[];
}

export type GhRunner = (args: string[]) => string;

export function parseSemverTag(tag: string): [number, number, number] {
  const match = STABLE_TAG_RE.exec(tag.trim());
  if (!match) {
    throw new Error(`Invalid stable release tag: ${tag}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemverTag(a);
  const right = parseSemverTag(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

/** Select the newest published non-draft, non-prerelease stable vX.Y.Z release, or null. */
export function selectLatestStableRelease(releases: readonly GitHubReleaseSummary[]): GitHubReleaseSummary | null {
  const stable = releases.filter(
    release => !release.draft && !release.prerelease && STABLE_TAG_RE.test(release.tag_name ?? ""),
  );
  stable.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  return stable[0] ?? null;
}

export function runGh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runGhJson<T>(args: string[], gh: GhRunner = runGh): T {
  return JSON.parse(gh(args)) as T;
}

export function isHttp404(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { stderr?: unknown; message?: unknown };
  const text = `${String(err.stderr ?? "")}\n${String(err.message ?? "")}`;
  return /\bHTTP 404\b/i.test(text);
}

export function listReleases(repo: string, gh: GhRunner = runGh): GitHubReleaseSummary[] {
  const pages = runGhJson<GitHubReleaseSummary[] | GitHubReleaseSummary[][]>(
    ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`],
    gh,
  );
  return pages.flat();
}

export function currentLatestTag(repo: string, gh: GhRunner = runGh): string | null {
  try {
    const tag = gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]).trim();
    return tag || null;
  } catch (error) {
    if (isHttp404(error)) return null;
    throw error;
  }
}
