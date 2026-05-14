import { describe, it, expect } from "vitest";
import {
  applyLeanFilter,
  applyOnDemandFilter,
  applyLeanOnDemandFilter,
  LEAN_REMOVE_LIST,
  STUB_SCHEMA_MAP,
  parseModeFeatures,
  estimateInputTokens,
  WaferFixPatcher,
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

// ---------------------------------------------------------------------------
// parseModeFeatures
// ---------------------------------------------------------------------------
describe("parseModeFeatures", () => {
  it("parses single lean", () => {
    const f = parseModeFeatures("lean");
    expect(f).toEqual({ lean: true, onDemand: false, waferFix: false });
  });

  it("parses single on-demand", () => {
    const f = parseModeFeatures("on-demand");
    expect(f).toEqual({ lean: false, onDemand: true, waferFix: false });
  });

  it("parses wafer-fix alone", () => {
    const f = parseModeFeatures("wafer-fix");
    expect(f).toEqual({ lean: false, onDemand: false, waferFix: true });
  });

  it("parses lean,wafer-fix combo", () => {
    const f = parseModeFeatures("lean,wafer-fix");
    expect(f).toEqual({ lean: true, onDemand: false, waferFix: true });
  });

  it("parses on-demand,wafer-fix combo", () => {
    const f = parseModeFeatures("on-demand,wafer-fix");
    expect(f).toEqual({ lean: false, onDemand: true, waferFix: true });
  });

  it("parses lean,on-demand,wafer-fix triple combo", () => {
    const f = parseModeFeatures("lean,on-demand,wafer-fix");
    expect(f).toEqual({ lean: true, onDemand: true, waferFix: true });
  });

  it("legacy lean-on-demand sets both lean and onDemand", () => {
    const f = parseModeFeatures("lean-on-demand");
    expect(f).toEqual({ lean: true, onDemand: true, waferFix: false });
  });

  it("observe returns all false", () => {
    const f = parseModeFeatures("observe");
    expect(f).toEqual({ lean: false, onDemand: false, waferFix: false });
  });
});

// ---------------------------------------------------------------------------
// estimateInputTokens
// ---------------------------------------------------------------------------
describe("estimateInputTokens", () => {
  it("divides bytes by 4 and rounds", () => {
    expect(estimateInputTokens(280000)).toBe(70000);
    expect(estimateInputTokens(301)).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// WaferFixPatcher
// ---------------------------------------------------------------------------
describe("WaferFixPatcher", () => {
  const MSG_START =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n';
  const CONTENT_BLOCK =
    'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n';

  it("patches input_tokens:0 when full first event arrives in one chunk", () => {
    const patcher = new WaferFixPatcher(71000);
    const result = patcher.process(Buffer.from(MSG_START + CONTENT_BLOCK));
    const text = Buffer.concat(result).toString("utf-8");
    expect(text).toContain('"input_tokens":71000');
    expect(text).not.toContain('"input_tokens":0');
    expect(text).toContain(CONTENT_BLOCK);
  });

  it("buffers partial first event, patches when boundary arrives", () => {
    const patcher = new WaferFixPatcher(50000);
    const half = Math.floor(MSG_START.length / 2);
    const first = patcher.process(Buffer.from(MSG_START.slice(0, half)));
    expect(first).toHaveLength(0); // still buffering
    const second = patcher.process(Buffer.from(MSG_START.slice(half) + CONTENT_BLOCK));
    const text = Buffer.concat(second).toString("utf-8");
    expect(text).toContain('"input_tokens":50000');
    expect(text).toContain(CONTENT_BLOCK);
  });

  it("passes subsequent chunks through without buffering", () => {
    const patcher = new WaferFixPatcher(1000);
    patcher.process(Buffer.from(MSG_START)); // prime it
    const chunk2 = Buffer.from(CONTENT_BLOCK);
    const out = patcher.process(chunk2);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(chunk2); // exact same buffer reference
  });

  it("does not patch when input_tokens is non-zero", () => {
    const patcher = new WaferFixPatcher(99999);
    const withRealTokens = MSG_START.replace('"input_tokens":0', '"input_tokens":42000');
    const result = patcher.process(Buffer.from(withRealTokens));
    const text = Buffer.concat(result).toString("utf-8");
    expect(text).toContain('"input_tokens":42000');
    expect(text).not.toContain('"input_tokens":99999');
  });

  it("flush returns remaining buffer if stream ends before \\n\\n", () => {
    const patcher = new WaferFixPatcher(1000);
    const partial = "event: message_start\ndata: {partial";
    patcher.process(Buffer.from(partial));
    const flushed = patcher.flush();
    expect(Buffer.concat(flushed).toString("utf-8")).toBe(partial);
    expect(patcher.flush()).toHaveLength(0); // empty after flush
  });
});
