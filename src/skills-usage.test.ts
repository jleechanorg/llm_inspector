import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkillsUsage, formatSkillsUsage } from "./skills-usage.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function skillToolUseLine(timestamp: string, skill: string): string {
  return line({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Skill",
          input: { skill },
        },
      ],
    },
  });
}

function slashCommandLine(timestamp: string, command: string): string {
  return line({
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: `<command-name>${command}</command-name>\n<command-message>...`,
    },
  });
}

function slashCommandBlockLine(timestamp: string, command: string): string {
  return line({
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text: `<command-name>${command}</command-name>` }],
    },
  });
}

describe("scanSkillsUsage", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "llm-inspector-skills-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  it("returns empty result when no projects dir exists", async () => {
    const result = await scanSkillsUsage({
      projectsDir: join(projectsDir, "does-not-exist"),
    });
    expect(result.entries).toHaveLength(0);
    expect(result.scannedFiles).toBe(0);
    expect(result.totalInvocations).toBe(0);
  });

  it("counts Skill tool invocations grouped by skill name", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const now = new Date().toISOString();
    const content = [
      skillToolUseLine(now, "harness-engineering"),
      skillToolUseLine(now, "harness-engineering"),
      skillToolUseLine(now, "nextsteps"),
    ].join("\n");
    await writeFile(join(projDir, "session1.jsonl"), content);

    const result = await scanSkillsUsage({ projectsDir });

    const harness = result.entries.find((e) => e.name === "harness-engineering");
    const nextsteps = result.entries.find((e) => e.name === "nextsteps");
    expect(harness?.count).toBe(2);
    expect(harness?.source).toBe("skill_tool");
    expect(nextsteps?.count).toBe(1);
    expect(result.totalInvocations).toBe(3);
    expect(result.scannedFiles).toBe(1);
  });

  it("counts slash-command invocations from <command-name> tags (string content)", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const now = new Date().toISOString();
    const content = [
      slashCommandLine(now, "/copilot"),
      slashCommandLine(now, "/copilot"),
      slashCommandLine(now, "/green"),
    ].join("\n");
    await writeFile(join(projDir, "session1.jsonl"), content);

    const result = await scanSkillsUsage({ projectsDir });

    const copilot = result.entries.find((e) => e.name === "/copilot");
    expect(copilot?.count).toBe(2);
    expect(copilot?.source).toBe("slash_command");
    expect(result.entries.find((e) => e.name === "/green")?.count).toBe(1);
  });

  it("counts slash-command invocations from content-block text", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      join(projDir, "session1.jsonl"),
      slashCommandBlockLine(now, "/learn"),
    );

    const result = await scanSkillsUsage({ projectsDir });
    expect(result.entries.find((e) => e.name === "/learn")?.count).toBe(1);
  });

  it("excludes entries older than the requested window", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const content = [
      skillToolUseLine(recent, "recent-skill"),
      skillToolUseLine(old, "old-skill"),
    ].join("\n");
    await writeFile(join(projDir, "session1.jsonl"), content);

    const result = await scanSkillsUsage({ projectsDir, days: 7 });

    expect(result.entries.find((e) => e.name === "recent-skill")).toBeDefined();
    expect(result.entries.find((e) => e.name === "old-skill")).toBeUndefined();
  });

  it("skips malformed JSON lines without throwing", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const now = new Date().toISOString();
    const content = [
      "{not valid json",
      skillToolUseLine(now, "good-skill"),
      "",
    ].join("\n");
    await writeFile(join(projDir, "session1.jsonl"), content);

    const result = await scanSkillsUsage({ projectsDir });
    expect(result.entries.find((e) => e.name === "good-skill")?.count).toBe(1);
  });

  it("scans multiple project subdirectories", async () => {
    const proj1 = join(projectsDir, "-home-user-repo1");
    const proj2 = join(projectsDir, "-home-user-repo2");
    await mkdir(proj1, { recursive: true });
    await mkdir(proj2, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(join(proj1, "a.jsonl"), skillToolUseLine(now, "skill-a"));
    await writeFile(join(proj2, "b.jsonl"), skillToolUseLine(now, "skill-b"));

    const result = await scanSkillsUsage({ projectsDir });
    expect(result.scannedFiles).toBe(2);
    expect(result.entries.map((e) => e.name).sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("sorts entries descending by count", async () => {
    const projDir = join(projectsDir, "-home-user-repo");
    await mkdir(projDir, { recursive: true });
    const now = new Date().toISOString();
    const content = [
      skillToolUseLine(now, "rare"),
      skillToolUseLine(now, "common"),
      skillToolUseLine(now, "common"),
      skillToolUseLine(now, "common"),
    ].join("\n");
    await writeFile(join(projDir, "session1.jsonl"), content);

    const result = await scanSkillsUsage({ projectsDir });
    expect(result.entries[0].name).toBe("common");
    expect(result.entries[0].count).toBe(3);
  });
});

describe("formatSkillsUsage", () => {
  it("reports no invocations found for empty results", () => {
    const output = formatSkillsUsage({
      windowDays: 30,
      since: new Date().toISOString(),
      scannedFiles: 0,
      parsedLines: 0,
      entries: [],
      totalInvocations: 0,
    });
    expect(output).toContain("No skill or slash-command invocations found");
  });

  it("renders a table with skill names, source, and counts", () => {
    const output = formatSkillsUsage({
      windowDays: 30,
      since: new Date().toISOString(),
      scannedFiles: 2,
      parsedLines: 10,
      entries: [
        { name: "harness-engineering", count: 5, source: "skill_tool" },
        { name: "/copilot", count: 3, source: "slash_command" },
      ],
      totalInvocations: 8,
    });
    expect(output).toContain("harness-engineering");
    expect(output).toContain("Skill tool");
    expect(output).toContain("/copilot");
    expect(output).toContain("slash command");
    expect(output).toContain("TOTAL");
    expect(output).toContain("8");
  });
});
