export const LEAN_REMOVE_LIST = new Set([
  // Chrome browser automation (~29KB)
  "mcp__claude-in-chrome__computer",
  "mcp__claude-in-chrome__browser_batch",
  "mcp__claude-in-chrome__find",
  "mcp__claude-in-chrome__form_input",
  "mcp__claude-in-chrome__gif_creator",
  "mcp__claude-in-chrome__get_page_text",
  "mcp__claude-in-chrome__javascript_tool",
  "mcp__claude-in-chrome__navigate",
  "mcp__claude-in-chrome__read_console_messages",
  "mcp__claude-in-chrome__read_network_requests",
  "mcp__claude-in-chrome__read_page",
  "mcp__claude-in-chrome__resize_window",
  "mcp__claude-in-chrome__shortcuts_execute",
  "mcp__claude-in-chrome__shortcuts_list",
  "mcp__claude-in-chrome__switch_browser",
  "mcp__claude-in-chrome__tabs_close_mcp",
  "mcp__claude-in-chrome__tabs_context_mcp",
  "mcp__claude-in-chrome__tabs_create_mcp",
  "mcp__claude-in-chrome__upload_image",
  "mcp__claude-in-chrome__file_upload",
  "mcp__plugin_superpowers-chrome_chrome__use_browser",
  // Google Drive OAuth (~1.5KB)
  "mcp__claude_ai_Google_Drive__authenticate",
  "mcp__claude_ai_Google_Drive__complete_authentication",
]);

export const HEAVY_TOOL_NAMES = [
  "Agent",
  "TeamCreate",
  "TeamDelete",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "Skill",
  "RemoteTrigger",
] as const;

export type HeavyToolName = (typeof HEAVY_TOOL_NAMES)[number];

const HEAVY_DESCRIPTIONS: Record<HeavyToolName, string> = {
  Agent: "Spawn an autonomous sub-agent to handle a task.",
  TeamCreate: "Create a team of agents to coordinate on a shared goal.",
  TeamDelete: "Delete a team and free its resources.",
  TaskCreate: "Create a task in a team's task list.",
  TaskUpdate: "Update a task's status or details.",
  TaskGet: "Get details about a specific task.",
  TaskList: "List tasks in a team's task list.",
  TaskOutput: "Get the output of a completed task.",
  TaskStop: "Stop a running task.",
  SendMessage: "Send a message to an agent or team.",
  CronCreate: "Schedule a prompt to run on a recurring cron schedule.",
  CronDelete: "Delete a scheduled cron job.",
  CronList: "List all scheduled cron jobs.",
  EnterWorktree: "Enter a git worktree for isolated development.",
  ExitWorktree: "Exit the current git worktree.",
  Skill: "Invoke a named skill.",
  RemoteTrigger: "Trigger a remote agent via webhook.",
};

export function makeStubSchema(name: HeavyToolName) {
  return {
    name,
    description: HEAVY_DESCRIPTIONS[name],
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Request this tool only if it is necessary for the current task.",
        },
      },
      required: [],
    },
  };
}

export const STUB_SCHEMA_MAP = new Map<string, ReturnType<typeof makeStubSchema>>();
for (const name of HEAVY_TOOL_NAMES) {
  STUB_SCHEMA_MAP.set(name, makeStubSchema(name));
}

export type Body = Record<string, unknown>;

export type LeanResult = {
  modified: Body;
  stripped: string[];
};

export type OnDemandResult = {
  modified: Body;
  stubbedTools: Map<string, unknown>;
};

export type LeanOnDemandResult = {
  modified: Body;
  stripped: string[];
  stubbedTools: Map<string, unknown>;
};

export function applyLeanFilter(body: Body): LeanResult {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { modified: body, stripped: [] };
  }
  const kept: unknown[] = [];
  const stripped: string[] = [];
  for (const tool of tools) {
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : "";
    if (LEAN_REMOVE_LIST.has(name)) {
      stripped.push(name);
    } else {
      kept.push(tool);
    }
  }
  if (stripped.length === 0) return { modified: body, stripped: [] };
  return { modified: { ...body, tools: kept }, stripped };
}

export function applyOnDemandFilter(body: Body): OnDemandResult {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { modified: body, stubbedTools: new Map() };
  }
  const kept: unknown[] = [];
  const stubbedTools = new Map<string, unknown>();
  for (const tool of tools) {
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : "";
    const stub = STUB_SCHEMA_MAP.get(name);
    if (stub) {
      kept.push(stub);
      stubbedTools.set(name, tool);
    } else {
      kept.push(tool);
    }
  }
  if (stubbedTools.size === 0) return { modified: body, stubbedTools };
  return { modified: { ...body, tools: kept }, stubbedTools };
}

// Combined: strip LEAN_REMOVE_LIST entirely, stub HEAVY_TOOL_NAMES with minimal schemas.
export function applyLeanOnDemandFilter(body: Body): LeanOnDemandResult {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { modified: body, stripped: [], stubbedTools: new Map() };
  }
  const kept: unknown[] = [];
  const stripped: string[] = [];
  const stubbedTools = new Map<string, unknown>();
  for (const tool of tools) {
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : "";
    if (LEAN_REMOVE_LIST.has(name)) {
      stripped.push(name);
    } else {
      const stub = STUB_SCHEMA_MAP.get(name);
      if (stub) {
        kept.push(stub);
        stubbedTools.set(name, tool);
      } else {
        kept.push(tool);
      }
    }
  }
  if (stripped.length === 0 && stubbedTools.size === 0) {
    return { modified: body, stripped: [], stubbedTools: new Map() };
  }
  return { modified: { ...body, tools: kept }, stripped, stubbedTools };
}
