import { describe, it, expect } from "vitest";
import {
  applyLeanFilter,
  applyOnDemandFilter,
  applyLeanOnDemandFilter,
  LEAN_REMOVE_LIST,
  STUB_SCHEMA_MAP,
} from "./filters.js";

const chromeTool = { name: "mcp__claude-in-chrome__navigate", description: "nav", input_schema: {} };
const driveTool = { name: "mcp__claude_ai_Google_Drive__authenticate", description: "auth", input_schema: {} };
const bashTool = { name: "Bash", description: "run bash", input_schema: {} };
const agentTool = { name: "Agent", description: "big agent schema...", input_schema: { properties: { prompt: {} }, required: ["prompt"] } };
const taskCreateTool = { name: "TaskCreate", description: "big task schema...", input_schema: { properties: { subject: {} }, required: ["subject"] } };
const slackTool = { name: "mcp__slack__channels_list", description: "list channels", input_schema: {} };

// ---------------------------------------------------------------------------
// applyLeanFilter
// ---------------------------------------------------------------------------
describe("applyLeanFilter", () => {
  it("strips chrome and drive tools, keeps everything else", () => {
    const body = { tools: [chromeTool, driveTool, bashTool, slackTool] };
    const { modified, stripped } = applyLeanFilter(body);
    const names = (modified.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["Bash", "mcp__slack__channels_list"]);
    expect(stripped).toContain("mcp__claude-in-chrome__navigate");
    expect(stripped).toContain("mcp__claude_ai_Google_Drive__authenticate");
  });

  it("returns body unmodified when no tools match remove list", () => {
    const body = { tools: [bashTool, slackTool] };
    const { modified, stripped } = applyLeanFilter(body);
    expect(modified).toBe(body);
    expect(stripped).toHaveLength(0);
  });

  it("handles empty tools array", () => {
    const body = { tools: [] };
    const { modified, stripped } = applyLeanFilter(body);
    expect(modified).toBe(body);
    expect(stripped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyOnDemandFilter
// ---------------------------------------------------------------------------
describe("applyOnDemandFilter", () => {
  it("replaces heavy tools with stubs, preserves originals in stubbedTools map", () => {
    const body = { tools: [bashTool, agentTool, taskCreateTool] };
    const { modified, stubbedTools } = applyOnDemandFilter(body);
    const tools = modified.tools as { name: string; input_schema: { properties?: object }; inputSchema?: object }[];
    const agentInBody = tools.find((t) => t.name === "Agent")!;
    expect(agentInBody.input_schema.properties).toEqual({
      task: { type: "string", description: "Request this tool only if it is necessary for the current task." },
    });
    expect(agentInBody.inputSchema).toBeUndefined();
    expect(stubbedTools.get("Agent")).toBe(agentTool);
    expect(stubbedTools.get("TaskCreate")).toBe(taskCreateTool);
    expect(stubbedTools.size).toBe(2);
  });

  it("passes through non-heavy tools unchanged", () => {
    const body = { tools: [bashTool, slackTool] };
    const { modified, stubbedTools } = applyOnDemandFilter(body);
    expect(modified).toBe(body);
    expect(stubbedTools.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyLeanOnDemandFilter — combined mode
// ---------------------------------------------------------------------------
describe("applyLeanOnDemandFilter", () => {
  it("strips lean-remove tools AND stubs heavy tools in one pass", () => {
    const body = { tools: [chromeTool, driveTool, bashTool, agentTool, taskCreateTool, slackTool] };
    const { modified, stripped, stubbedTools } = applyLeanOnDemandFilter(body);

    const names = (modified.tools as { name: string }[]).map((t) => t.name);

    // Chrome + Drive stripped entirely
    expect(names).not.toContain("mcp__claude-in-chrome__navigate");
    expect(names).not.toContain("mcp__claude_ai_Google_Drive__authenticate");
    expect(stripped).toContain("mcp__claude-in-chrome__navigate");
    expect(stripped).toContain("mcp__claude_ai_Google_Drive__authenticate");

    // Bash + Slack pass through untouched
    expect(names).toContain("Bash");
    expect(names).toContain("mcp__slack__channels_list");

    // Agent + TaskCreate present as stubs
    expect(names).toContain("Agent");
    expect(names).toContain("TaskCreate");
    const agentInBody = (modified.tools as { name: string; input_schema: { properties?: object }; inputSchema?: object }[]).find(
      (t) => t.name === "Agent",
    )!;
    expect(agentInBody.input_schema.properties).toEqual({
      task: { type: "string", description: "Request this tool only if it is necessary for the current task." },
    });
    expect(agentInBody.inputSchema).toBeUndefined();

    // Originals preserved for re-issue
    expect(stubbedTools.get("Agent")).toBe(agentTool);
    expect(stubbedTools.get("TaskCreate")).toBe(taskCreateTool);
    expect(stubbedTools.size).toBe(2);
  });

  it("lean-remove takes priority: chrome tool is NOT stubbed even if it were in heavy list", () => {
    // Ensures lean strip wins over stub when a tool is in both lists (edge case)
    const body = { tools: [chromeTool] };
    const { modified, stripped, stubbedTools } = applyLeanOnDemandFilter(body);
    expect((modified.tools as unknown[]).length).toBe(0);
    expect(stripped).toHaveLength(1);
    expect(stubbedTools.size).toBe(0);
  });

  it("returns body unmodified when nothing to strip or stub", () => {
    const body = { tools: [bashTool, slackTool] };
    const { modified, stripped, stubbedTools } = applyLeanOnDemandFilter(body);
    expect(modified).toBe(body);
    expect(stripped).toHaveLength(0);
    expect(stubbedTools.size).toBe(0);
  });

  it("handles missing tools field", () => {
    const body = { model: "claude-3" };
    const { modified, stripped, stubbedTools } = applyLeanOnDemandFilter(body);
    expect(modified).toBe(body);
    expect(stripped).toHaveLength(0);
    expect(stubbedTools.size).toBe(0);
  });
});
