import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EcosystemSyncError,
  readBoundedNonSymlinkFile,
  sha256Hex,
} from "./cli-sync-mcp";

export const MAX_ECOSYSTEM_SKILL_BYTES = 256 * 1024;
export const MAX_ECOSYSTEM_SKILLS = 128;
const SKILL_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface DiscoveredSkill {
  slug: string;
  digest: string;
  bytes: number;
  content?: Buffer;
}

export interface RedactedSkillSummary {
  slug: string;
  digest: string;
  bytes: number;
}

export interface CliSkillsReadResult {
  skills: Map<string, DiscoveredSkill>;
  warnings: string[];
}

export function isValidSkillSlug(slug: string): boolean {
  if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    return false;
  }
  return SKILL_SLUG_PATTERN.test(slug);
}

export function redactSkillSummary(skill: DiscoveredSkill): RedactedSkillSummary {
  return {
    slug: skill.slug,
    digest: skill.digest,
    bytes: skill.bytes,
  };
}

export function readCliSkills(
  skillsDir: string,
  options: { strict?: boolean; includeContent?: boolean } = {},
): CliSkillsReadResult {
  const skills = new Map<string, DiscoveredSkill>();
  const warnings: string[] = [];

  let rootStat;
  try {
    rootStat = lstatSync(skillsDir);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return { skills, warnings };
    }
    throw new EcosystemSyncError(`Cannot inspect skills directory ${skillsDir}: ${(error as Error).message}`, 400, "ecosystem_io_error");
  }

  if (rootStat.isSymbolicLink()) {
    throw new EcosystemSyncError(`Refusing symlinked skills directory: ${skillsDir}`, 400, "ecosystem_symlink_refused");
  }
  if (!rootStat.isDirectory()) {
    const message = `Skills path is not a directory: ${skillsDir}`;
    if (options.strict) throw new EcosystemSyncError(message, 400, "ecosystem_invalid_file");
    warnings.push(message);
    return { skills, warnings };
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > 512) {
    throw new EcosystemSyncError(
      `Skills directory entry count (${entries.length}) exceeds safe traversal limit`,
      400,
      "ecosystem_limit_exceeded",
    );
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      const msg = `Refusing symlinked skill entry: ${entry.name}`;
      if (options.strict) throw new EcosystemSyncError(msg, 400, "ecosystem_symlink_refused");
      warnings.push(msg);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    if (!isValidSkillSlug(entry.name)) {
      const msg = `Invalid skill slug: ${entry.name}`;
      if (options.strict) throw new EcosystemSyncError(msg, 400, "ecosystem_invalid_slug");
      warnings.push(msg);
      continue;
    }

    const skillDir = join(skillsDir, entry.name);
    let dirStat;
    try {
      dirStat = lstatSync(skillDir);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      const msg = `Refusing symlinked skill directory: ${entry.name}`;
      if (options.strict) throw new EcosystemSyncError(msg, 400, "ecosystem_symlink_refused");
      warnings.push(msg);
      continue;
    }

    const skillMdPath = join(skillDir, "SKILL.md");
    let content: Buffer | null;
    try {
      content = readBoundedNonSymlinkFile(skillMdPath, MAX_ECOSYSTEM_SKILL_BYTES, `skill ${entry.name}/SKILL.md`);
    } catch (error) {
      if (options.strict || (error instanceof EcosystemSyncError && error.code === "ecosystem_limit_exceeded")) {
        throw error;
      }
      warnings.push((error as Error).message);
      continue;
    }

    if (content === null) {
      continue;
    }

    if (skills.size >= MAX_ECOSYSTEM_SKILLS) {
      throw new EcosystemSyncError(
        `Skills count exceeds limit of ${MAX_ECOSYSTEM_SKILLS}`,
        400,
        "ecosystem_limit_exceeded",
      );
    }

    skills.set(entry.name, {
      slug: entry.name,
      digest: sha256Hex(content),
      bytes: content.byteLength,
      ...(options.includeContent ? { content } : {}),
    });
  }

  return { skills, warnings };
}
