import { findCommand } from "./registry";

// Presentation owns selection/order only; names and summaries belong to registry.
const ACTION_GROUPS = [
  { title: "Start here", commands: ["setup", "start", "status"] },
  { title: "Common tasks", commands: ["doctor", "logs", "usage"] },
] as const;

const FAMILY_GROUPS = [
  ["provider", "account", "models", "alias"],
  ["combo", "route", "agent", "effort"],
  ["observe", "inspect", "access", "api"],
  ["config", "system", "integration"],
] as const;

function publicCommand(name: string) {
  const entry = findCommand(name);
  if (!entry || entry.hidden) throw new Error(`Invalid public help group command: ${name}`);
  return entry;
}

function actionLines(name: string): string[] {
  const entry = publicCommand(name);
  const prefix = `  epx ${entry.name}`.padEnd(16);
  const lines: string[] = [];
  let line = prefix;
  for (const word of entry.summary.split(/\s+/)) {
    if (line.trim() && line.length + word.length + 1 > 80 && line !== prefix) {
      lines.push(line);
      line = " ".repeat(prefix.length);
    }
    line += `${line.endsWith(" ") ? "" : " "}${word}`;
  }
  lines.push(line);
  return lines;
}

export function renderRootHelp(): string {
  const lines = ["easyproxy (epx) — Universal provider proxy for Codex", "Usage: epx <command> [options]"];
  for (const group of ACTION_GROUPS) {
    lines.push("", `${group.title}:`, ...group.commands.flatMap(actionLines));
  }
  lines.push("", "Explore:");
  for (const group of FAMILY_GROUPS) lines.push(`  ${group.map(name => publicCommand(name).name).join("  ")}`);
  lines.push("", "More help:",
    "  epx help <command>       Command usage and declared topics",
    "  epx help --all           Complete command reference",
    "  epx capabilities --json  Declared capabilities for scripts");
  return lines.join("\n");
}
