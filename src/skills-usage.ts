/**
 * Skills usage: scans Claude Code session JSONL logs (under ~/.claude/projects,
 * one subdirectory per project, one .jsonl file per session) to report which
 * skills (invoked via the Skill tool) and slash commands were
 * used, and how often, over a given time window.
 *
 * This is pure deterministic log parsing (structured field extraction), not
 * semantic classification — the Skill tool name and slash-command tags are
 * fixed, known markers emitted by Claude Code itself.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatTable, formatNumber } from "./utils.js";

/** Default location of Claude Code session logs. */
export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Default lookback window (days) when none is specified. */
export const DEFAULT_SKILLS_USAGE_WINDOW_DAYS = 30;

export type SkillUsageSource = "skill_tool" | "slash_command";

export interface SkillUsageEntry {
  name: string;
  count: number;
  source: SkillUsageSource;
}

export interface SkillsUsageResult {
  windowDays: number;
  /** ISO timestamp of the start of the window. */
  since: string;
  scannedFiles: number;
  /** Number of JSONL log lines that fell within the window and parsed cleanly. */
  parsedLines: number;
  /** Entries sorted descending by count. */
  entries: SkillUsageEntry[];
  totalInvocations: number;
}

const COMMAND_NAME_REGEX = /<command-name>\s*\/?([^\s<]+)\s*<\/command-name>/g;

/** Extract slash-command names (e.g. "/copilot") from a `<command-name>` tagged string. */
function extractSlashCommands(content: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  COMMAND_NAME_REGEX.lastIndex = 0;
  while ((match = COMMAND_NAME_REGEX.exec(content)) !== null) {
    names.push(`/${match[1]}`);
  }
  return names;
}

/** Recursively list every *.jsonl file directly under each project subdirectory. */
async function findSessionFiles(projectsDir: string): Promise<string[]> {
  if (!existsSync(projectsDir)) return [];

  const files: string[] = [];
  let topEntries;
  try {
    topEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of topEntries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(projectsDir, entry.name);
    if (entry.isDirectory()) {
      let subEntries: string[];
      try {
        subEntries = await readdir(fullPath);
      } catch {
        continue;
      }
      for (const f of subEntries) {
        if (f.endsWith(".jsonl")) files.push(join(fullPath, f));
      }
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function bumpCount(
  counts: Map<string, { count: number; source: SkillUsageSource }>,
  name: string,
  source: SkillUsageSource,
): void {
  const existing = counts.get(name);
  if (existing) {
    existing.count += 1;
  } else {
    counts.set(name, { count: 1, source });
  }
}

/** Record any Skill-tool invocations and slash-command usages found in one parsed log entry. */
function recordEntry(
  entry: Record<string, unknown>,
  counts: Map<string, { count: number; source: SkillUsageSource }>,
): void {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;

  // 1. Skill tool invocations: assistant tool_use blocks with name === "Skill".
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use" &&
        (block as { name?: string }).name === "Skill"
      ) {
        const input = (block as { input?: { skill?: unknown } }).input;
        const skillName = input?.skill;
        if (typeof skillName === "string" && skillName.length > 0) {
          bumpCount(counts, skillName, "skill_tool");
        }
      }
    }
  }

  // 2. Slash-command invocations: user messages containing <command-name> tags.
  if (entry.type === "user") {
    if (typeof content === "string" && content.includes("<command-name>")) {
      for (const cmd of extractSlashCommands(content)) {
        bumpCount(counts, cmd, "slash_command");
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { type?: string; text?: string } | undefined);
        if (
          text &&
          text.type === "text" &&
          typeof text.text === "string" &&
          text.text.includes("<command-name>")
        ) {
          for (const cmd of extractSlashCommands(text.text)) {
            bumpCount(counts, cmd, "slash_command");
          }
        }
      }
    }
  }
}

/**
 * Scan Claude Code session JSONL logs and count skill/slash-command usage
 * within the given time window.
 */
export async function scanSkillsUsage(options?: {
  projectsDir?: string;
  days?: number;
}): Promise<SkillsUsageResult> {
  const projectsDir = options?.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR;
  const windowDays = options?.days ?? DEFAULT_SKILLS_USAGE_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const files = await findSessionFiles(projectsDir);
  const counts = new Map<string, { count: number; source: SkillUsageSource }>();
  let parsedLines = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip malformed / truncated lines
      }

      const timestamp = entry.timestamp;
      if (typeof timestamp === "string") {
        const ts = new Date(timestamp);
        if (!Number.isNaN(ts.getTime()) && ts < since) continue;
      }

      parsedLines += 1;
      recordEntry(entry, counts);
    }
  }

  const entries: SkillUsageEntry[] = Array.from(counts.entries())
    .map(([name, v]) => ({ name, count: v.count, source: v.source }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const totalInvocations = entries.reduce((sum, e) => sum + e.count, 0);

  return {
    windowDays,
    since: since.toISOString(),
    scannedFiles: files.length,
    parsedLines,
    entries,
    totalInvocations,
  };
}

/** Format a SkillsUsageResult as a human-readable ASCII report. */
export function formatSkillsUsage(result: SkillsUsageResult): string {
  const lines: string[] = [];
  lines.push("=== Skills Usage ===");
  lines.push(
    `Window: last ${result.windowDays} day${result.windowDays === 1 ? "" : "s"} (since ${result.since.slice(0, 10)})`,
  );
  lines.push(
    `Scanned ${result.scannedFiles} session file(s), ${result.parsedLines} log entries in window.`,
  );
  lines.push("");

  if (result.entries.length === 0) {
    lines.push("No skill or slash-command invocations found in this window.");
    return lines.join("\n");
  }

  const rows: string[][] = [["Skill / Command", "Source", "Count"]];
  for (const e of result.entries) {
    rows.push([
      e.name,
      e.source === "skill_tool" ? "Skill tool" : "slash command",
      formatNumber(e.count),
    ]);
  }
  rows.push(["TOTAL", "", formatNumber(result.totalInvocations)]);

  lines.push(formatTable(rows));
  return lines.join("\n");
}
