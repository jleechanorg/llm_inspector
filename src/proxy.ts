/**
 * Transparent capture proxy for LLM API requests.
 * Intercepts requests, saves full payloads to disk,
 * forwards to upstream API, and streams responses back.
 */

import express from "express";
import http from "node:http";
import https from "node:https";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CapturedRequest } from "./types.js";
import {
  ensureCaptureDir,
  getPidFile,
  getConfigDir,
  redactHeaders,
  estimateTokens,
  DEFAULT_PORT,
} from "./utils.js";

/**
 * Auto-detect upstream base URL from request path.
 * Returns the base URL and the (possibly rewritten) path.
 */
function resolveUpstream(
  path: string,
  envOverride?: string,
): { baseUrl: string; rewrittenPath: string } {
  if (envOverride) {
    // envOverride is the base URL (e.g. http://127.0.0.1:8001)
    // ccproxy serves at /claude/v1/messages, so prepend /claude to path
    return { baseUrl: envOverride, rewrittenPath: "/claude" + path };
  }

  // Default: forward to ccproxy at :8000/claude (ccproxy's Anthropic-compat route)
  // This matches what we measured: Claude Code sends to /v1/messages,
  // ccproxy expects requests at /claude/v1/messages
  return {
    baseUrl: "http://127.0.0.1:8000",
    rewrittenPath: "/claude" + path,
  };
}

/**
 * Compute a quick summary of component sizes from the request body.
 */
function computeSummary(body: CapturedRequest["body"]): Record<string, number> {
  const summary: Record<string, number> = {};

  if (body.system) {
    const sysStr =
      typeof body.system === "string"
        ? body.system
        : JSON.stringify(body.system);
    summary["system_prompt"] = Buffer.byteLength(sysStr, "utf-8");
  }

  if (body.tools && Array.isArray(body.tools)) {
    let builtinBytes = 0;
    let mcpBytes = 0;
    for (const tool of body.tools) {
      const toolStr = JSON.stringify(tool);
      const size = Buffer.byteLength(toolStr, "utf-8");
      if (tool.name.startsWith("mcp__")) {
        mcpBytes += size;
      } else {
        builtinBytes += size;
      }
    }
    if (builtinBytes > 0) summary["builtin_tools"] = builtinBytes;
    if (mcpBytes > 0) summary["mcp_tools"] = mcpBytes;
  }

  if (body.messages && Array.isArray(body.messages)) {
    let msgBytes = 0;
    for (const msg of body.messages) {
      msgBytes += Buffer.byteLength(JSON.stringify(msg), "utf-8");
    }
    summary["messages"] = msgBytes;
  }

  return summary;
}

/**
 * Built-in tools considered "lean" — always safe to include.
 * Heavy tools (Agent, TeamCreate, etc.) are stripped in lean mode to save ~20K tokens/turn.
 */
const LEAN_TOOLS = new Set([
  "Bash", "Read", "Write", "Edit", "MultiEdit",
  "Glob", "Grep", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "NotebookEdit",
  // Context7 is tiny and generally useful
  "mcp__context7__resolve-library-id", "mcp__context7__get-library-docs",
]);

/**
 * Heavy built-in tools that get stubbed in on-demand mode.
 * Each stub is ~100 bytes vs the full schema which can be 3-18KB.
 */
const HEAVY_TOOL_NAMES = [
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

type HeavyToolName = (typeof HEAVY_TOOL_NAMES)[number];

/**
 * Minimal stub schema for a heavy tool — ~100 bytes vs 3-18KB full schema.
 * Preserves callability: model sees name + description + empty input schema,
 * generates tool_use, and the proxy can re-issue with the real schema.
 */
function makeStubSchema(name: HeavyToolName): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  // Per-tool one-liner descriptions
  const descriptions: Record<HeavyToolName, string> = {
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
  return {
    name,
    description: descriptions[name],
    // Claude Messages API format
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
      },
      required: ["task"],
    },
  };
}

/**
 * Build a map of heavy tool name -> stub schema.
 */
function buildStubSchemaMap(): Map<string, ReturnType<typeof makeStubSchema>> {
  const map = new Map<string, ReturnType<typeof makeStubSchema>>();
  for (const name of HEAVY_TOOL_NAMES) {
    map.set(name, makeStubSchema(name));
  }
  return map;
}

const STUB_SCHEMA_MAP = buildStubSchemaMap();

/**
 * Replace heavy tool schemas with stubs in on-demand mode.
 * Returns the modified body and a map of original tool -> stub (for re-issue expansion).
 */
function applyStubToolFilter(
  body: Record<string, unknown>,
): {
  modified: Record<string, unknown>;
  stubbedTools: Map<string, unknown>;
} {
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
      // Replace with stub; save original for re-issue
      kept.push(stub);
      stubbedTools.set(name, tool);
    } else {
      kept.push(tool);
    }
  }

  return {
    modified: { ...body, tools: kept },
    stubbedTools,
  };
}

/**
 * Strip heavy built-in tools from a request body in lean mode.
 * MCP tools (mcp__* prefix) are always kept — they're registered explicitly
 * and their cost is already optimized by the mcp-trim bead.
 * Returns the modified body and list of stripped tool names.
 */
function applyLeanToolFilter(
  body: Record<string, unknown>,
): { modified: Record<string, unknown>; stripped: string[] } {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { modified: body, stripped: [] };
  }

  const kept: unknown[] = [];
  const stripped: string[] = [];

  for (const tool of tools) {
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : "";
    // Keep all MCP tools (mcp__ prefix) and lean built-ins
    if (name.startsWith("mcp__") || LEAN_TOOLS.has(name)) {
      kept.push(tool);
    } else {
      stripped.push(name);
    }
  }

  if (stripped.length === 0) {
    return { modified: body, stripped: [] };
  }

  return {
    modified: { ...body, tools: kept },
    stripped,
  };
}

export type ToolMode = "observe" | "lean" | "on-demand";

// ---------------------------------------------------------------------------
// On-demand stub-schema re-issue infrastructure
// ---------------------------------------------------------------------------

/**
 * Per-request buffer state for on-demand mode.
 * All fields are scoped to a single request-id to ensure concurrent
 * requests don't interfere with each other.
 */
interface RequestBuffer {
  /** Original request body before stubbing (for re-issue) */
  originalBody: Record<string, unknown>;
  /** Original raw body bytes */
  originalRawBody: Buffer;
  /** Map of stubbed tool name -> original full tool schema */
  stubbedTools: Map<string, unknown>;
  /** Buffered SSE chunks from the stubbed response */
  sseChunks: string[];
  /** Set of stubbed tool names detected in the SSE stream */
  detectedStubbedTools: Set<string>;
  /** Whether re-issue has been initiated (prevents double re-issue) */
  reIssuing: boolean;
  /** Whether the stubbed response has been forwarded to client */
  stubbedForwarded: boolean;
}

/**
 * Map of request-id -> per-request buffer state.
 * Key is extracted from request body or generated fresh.
 */
const requestBuffers = new Map<string, RequestBuffer>();

/** Counter for generating request IDs when none exists in body */
let requestIdCounter = 0;
function nextRequestId(): string {
  return `req-${Date.now()}-${++requestIdCounter}`;
}

/**
 * Extract message ID from request body for request identification.
 * Returns a stable ID if present, otherwise generates one.
 */
function extractRequestId(body: Record<string, unknown>): string {
  // Claude API uses a top-level id field
  if (typeof body.id === "string" && body.id.length > 0) {
    return body.id;
  }
  // Fall back to generated ID
  return nextRequestId();
}

/**
 * Parse a single SSE data line and check for stubbed tool usage.
 * Returns the set of stubbed tool names detected in this chunk.
 *
 * Claude SSE format:
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Agent",...}}
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"..."}}
 */
function parseSSEForStubbedTools(
  line: string,
  stubbedToolNames: Set<string>,
): Set<string> {
  const detected = new Set<string>();
  if (!line.startsWith("data:")) return detected;

  const dataStr = line.slice(5).trim();
  if (!dataStr || dataStr === "[DONE]" || dataStr === "[done]") return detected;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return detected;
  }

  const type = typeof data.type === "string" ? data.type : "";

  // content_block_start: identifies which tool is being invoked
  if (type === "content_block_start") {
    const cb = data.content_block as Record<string, unknown> | undefined;
    if (cb && cb.type === "tool_use") {
      const name = typeof cb.name === "string" ? cb.name : "";
      if (stubbedToolNames.has(name)) {
        detected.add(name);
      }
    }
  }

  // content_block_delta with tool_use: the arguments are streaming in
  // We detect stubbed tools here too in case name came in a prior chunk
  if (type === "content_block_delta") {
    const delta = data.delta as Record<string, unknown> | undefined;
    if (delta && delta.type === "input_json_delta") {
      // Tool arguments are streaming — check if any prior content_block_start
      // for a stubbed tool is referenced via index
      // For simplicity: if we've seen any stubbed tool in this stream, we track it
      // The index maps to a content_block that started earlier
      const index = typeof data.index === "number" ? data.index : -1;
      if (index >= 0) {
        // We can't know the name from delta alone without maintaining index->name map
        // For now, rely on content_block_start detection
      }
    }
  }

  return detected;
}

/**
 * Synchronously scan buffered SSE text for stubbed tool usage.
 * Used when stream ends to check if any chunk contained stubbed tools.
 */
function scanBufferedSSEForStubbedTools(
  bufferedText: string,
  stubbedToolNames: Set<string>,
): Set<string> {
  const detected = new Set<string>();
  const lines = bufferedText.split("\n");
  for (const line of lines) {
    const found = parseSSEForStubbedTools(line, stubbedToolNames);
    for (const name of found) {
      detected.add(name);
    }
  }
  return detected;
}

/**
 * Re-issue the original request with full (non-stubbed) tool schemas.
 * Used when the stubbed response triggered use of a heavy tool.
 *
 * Returns the re-issued response body as a string, or throws on failure.
 */
async function reIssueWithFullSchema(
  originalBody: Record<string, unknown>,
  stubbedTools: Map<string, unknown>,
  upstream: URL,
  forwardHeaders: Record<string, string>,
): Promise<{ body: string; status: number }> {
  // Restore full schemas: replace stubs with original full tools
  const fullTools = originalBody.tools
    ? (originalBody.tools as unknown[]).map((tool) => {
        const t = tool as Record<string, unknown>;
        const name = typeof t.name === "string" ? t.name : "";
        // If this is a stub (from STUB_SCHEMA_MAP), replace with original
        if (STUB_SCHEMA_MAP.has(name)) {
          const original = stubbedTools.get(name);
          if (original) return original;
        }
        return tool;
      })
    : [];

  const fullBody = {
    ...originalBody,
    tools: fullTools,
  };

  const bodyStr = JSON.stringify(fullBody);
  const bodyBuf = Buffer.from(bodyStr, "utf-8");
  const headers = { ...forwardHeaders, "content-length": String(bodyBuf.length) };

  return new Promise((resolve, reject) => {
    const transport = upstream.protocol === "https:" ? https : http;
    const req = transport.request(
      upstream.href,
      { method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ body, status: res.statusCode || 200 });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

export interface StartProxyOptions {
  port?: number;
  upstream?: string;
  verbose?: boolean;
  /** observe: capture only (default); lean: strip heavy built-in tools */
  toolMode?: ToolMode;
}

/**
 * Start the capture proxy server.
 * Returns the HTTP server instance.
 */
export async function startProxy(
  options: StartProxyOptions = {},
): Promise<http.Server> {
  const port = options.port || DEFAULT_PORT;
  const upstreamOverride =
    options.upstream || process.env.LLM_INSPECTOR_UPSTREAM || undefined;
  const verbose = options.verbose ?? true;
  const toolMode: ToolMode =
    options.toolMode ||
    (process.env.LLM_INSPECTOR_TOOL_MODE as ToolMode | undefined) ||
    "observe";

  const captureDir = await ensureCaptureDir();

  const app = express();

  // Parse raw body for all content types
  app.use(
    express.raw({
      type: "*/*",
      limit: "50mb",
    }),
  );

  // Handle all requests
  app.all("*", async (req, res) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const originalPath = req.path;

    const { baseUrl, rewrittenPath } = resolveUpstream(
      originalPath,
      upstreamOverride,
    );
    const upstream = new URL(rewrittenPath, baseUrl);

    // GET requests: passthrough without capture
    if (method === "GET") {
      if (verbose) {
        console.log(`[llm-inspector] GET ${originalPath} -> ${upstream.href}`);
      }

      const transport = upstream.protocol === "https:" ? https : http;
      const forwardHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (key === "host") continue;
        if (typeof val === "string") forwardHeaders[key] = val;
        else if (Array.isArray(val)) forwardHeaders[key] = val.join(", ");
      }
      forwardHeaders["host"] = upstream.host;

      const proxyReq = transport.request(
        upstream.href,
        { method: "GET", headers: forwardHeaders },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", (err) => {
        console.error(`[llm-inspector] Proxy error: ${err.message}`);
        res.status(502).json({ error: "Upstream error", message: err.message });
      });
      proxyReq.end();
      return;
    }

    // POST and other methods: capture body, forward, capture response
    // express.raw() returns {} for bodyless methods (HEAD, OPTIONS) — normalize to empty Buffer
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const bodyStr = rawBody.toString("utf-8");
    const bodySize = rawBody.length;

    let parsedBody: CapturedRequest["body"] = {};
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      parsedBody = { _raw: bodyStr } as unknown as CapturedRequest["body"];
    }

    // Build headers record (for storage — redacted)
    const headerRecord: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === "string") headerRecord[key] = val;
      else if (Array.isArray(val)) headerRecord[key] = val.join(", ");
    }

    const captured: CapturedRequest = {
      timestamp,
      method,
      path: originalPath,
      url: req.url,
      headers: redactHeaders(headerRecord),
      body: parsedBody,
      bodySize,
    };

    // Apply tool mode filtering before forwarding
    let forwardBody = rawBody;
    let forwardBodySize = bodySize;
    let strippedTools: string[] = [];
    let stubbedToolsMap = new Map<string, unknown>();
    let requestId = "";

    // On-demand mode: replace heavy tool schemas with stubs
    if (toolMode === "on-demand" && method === "POST") {
      const { modified, stubbedTools } = applyStubToolFilter(
        parsedBody as Record<string, unknown>,
      );
      if (stubbedTools.size > 0) {
        stubbedToolsMap = stubbedTools;
        requestId = extractRequestId(parsedBody as Record<string, unknown>);
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        forwardBodySize = forwardBody.length;
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBodySize;

        // Initialize per-request buffer (Safeguard 3: per-request-id isolation)
        requestBuffers.set(requestId, {
          originalBody: parsedBody as Record<string, unknown>,
          originalRawBody: rawBody,
          stubbedTools: stubbedToolsMap,
          sseChunks: [],
          detectedStubbedTools: new Set(),
          reIssuing: false,
          stubbedForwarded: false,
        });
      }
    }

    // Lean mode: strip heavy tools entirely
    if (toolMode === "lean" && method === "POST") {
      const { modified, stripped } = applyLeanToolFilter(
        parsedBody as Record<string, unknown>,
      );
      if (stripped.length > 0) {
        strippedTools = stripped;
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        forwardBodySize = forwardBody.length;
        // Update parsedBody so the capture reflects what was actually sent
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBodySize;
      }
    }

    if (verbose) {
      const model = parsedBody.model || "unknown";
      const strippedNote =
        strippedTools.length > 0
          ? ` [lean: stripped ${strippedTools.length} tools: ${strippedTools.join(", ")}]`
          : stubbedToolsMap.size > 0
            ? ` [on-demand: stubbed ${stubbedToolsMap.size} tools: ${[...stubbedToolsMap.keys()].join(", ")}]`
            : "";
      console.log(
        `[llm-inspector] ${method} ${originalPath} -> ${upstream.href} (model: ${model}, ${bodySize} bytes → ${forwardBodySize} bytes)${strippedNote}`,
      );
    }

    // Build forward headers (original, non-redacted)
    const forwardHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (key === "host" || key === "content-length") continue;
      if (typeof val === "string") forwardHeaders[key] = val;
      else if (Array.isArray(val)) forwardHeaders[key] = val.join(", ");
    }
    forwardHeaders["host"] = upstream.host;
    forwardHeaders["content-length"] = String(forwardBodySize);

    const transport = upstream.protocol === "https:" ? https : http;

    const proxyReq = transport.request(
      upstream.href,
      { method, headers: forwardHeaders },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode || 200;
        const contentType = (proxyRes.headers["content-type"] as string) || "";
        const isStreaming = contentType.includes("text/event-stream");

        // Forward all response headers
        res.writeHead(statusCode, proxyRes.headers);

        if (isStreaming && requestId && requestBuffers.has(requestId)) {
          // ── On-demand SSE mode: buffer ALL chunks, scan for stubbed tool use ──
          // Safeguard 1: buffer ALL SSE from byte 1 (not just after tool_use detection)
          const buf = requestBuffers.get(requestId)!;
          const stubbedNames = new Set([...buf.stubbedTools.keys()]);
          const allChunks: Buffer[] = [];

          proxyRes.on("data", (chunk: Buffer) => {
            allChunks.push(chunk);
          });

          proxyRes.on("end", async () => {
            // Scan buffered text for any stubbed tool usage
            const fullText = Buffer.concat(allChunks).toString("utf-8");
            const detected = scanBufferedSSEForStubbedTools(fullText, stubbedNames);
            buf.sseChunks = allChunks.map((c) => c.toString("utf-8"));
            buf.detectedStubbedTools = detected;

            if (detected.size > 0 && !buf.reIssuing) {
              // ── Re-issue with full schemas ──
              buf.reIssuing = true;
              if (verbose) {
                console.log(
                  `[llm-inspector] on-demand: detected stubbed tools [${[...detected].join(", ")}] — re-issuing with full schemas`,
                );
              }

              try {
                // Safeguard 4: graceful fallback if re-issue fails
                const { body: reIssuedBody, status: reIssuedStatus } =
                  await reIssueWithFullSchema(
                    buf.originalBody,
                    buf.stubbedTools,
                    upstream,
                    forwardHeaders,
                  );
                res.write(reIssuedBody);
                captured.response = { status: reIssuedStatus };
              } catch (reErr) {
                console.error(
                  `[llm-inspector] on-demand re-issue failed: ${reErr}. Falling back to stubbed response.`,
                );
                // Fallback: forward stubbed response as degraded-but-complete
                for (const sseChunk of buf.sseChunks) {
                  res.write(sseChunk);
                }
                captured.response = {
                  status: statusCode,
                  body: {
                    _on_demand_reissue_failed: String(reErr),
                    _stubbed_tools_detected: [...detected],
                  },
                };
              }
            } else {
              // No stubbed tools detected — forward stubbed response
              buf.stubbedForwarded = true;
              for (const sseChunk of buf.sseChunks) {
                res.write(sseChunk);
              }
              captured.response = { status: statusCode };
            }

            // Cleanup per-request buffer
            requestBuffers.delete(requestId);

            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
            res.end();
          });
        } else if (isStreaming) {
          // Buffer streaming response to capture it
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            res.write(chunk);
          });
          proxyRes.on("end", () => {
            try {
              const fullBody = Buffer.concat(chunks).toString("utf-8");
              let parsedResponse: unknown;
              try {
                parsedResponse = JSON.parse(fullBody);
              } catch {
                parsedResponse = fullBody;
              }
              captured.response = {
                status: statusCode,
                body: parsedResponse,
              };
            } catch {
              captured.response = { status: statusCode };
            }
            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
            res.end();
          });
        } else {
          // Buffer non-streaming response to capture it
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            res.write(chunk);
          });
          proxyRes.on("end", () => {
            try {
              const fullBody = Buffer.concat(chunks).toString("utf-8");
              let parsedResponse: unknown;
              try {
                parsedResponse = JSON.parse(fullBody);
              } catch {
                parsedResponse = fullBody;
              }

              const respObj = parsedResponse as Record<string, unknown>;
              const usage = respObj?.usage as
                | { input_tokens?: number; output_tokens?: number }
                | undefined;

              captured.response = {
                status: statusCode,
                body: parsedResponse,
                usage,
              };
            } catch {
              captured.response = { status: statusCode };
            }

            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
            res.end();
          });
        }
      },
    );

    proxyReq.on("error", (err) => {
      console.error(`[llm-inspector] Upstream error: ${err.message}`);
      captured.response = { status: 502 };
      saveCapture(captured, captureDir).catch(() => {});
      res.status(502).json({ error: "Upstream error", message: err.message });
    });

    proxyReq.write(forwardBody);
    proxyReq.end();
  });

  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, async () => {
      // Ensure config dir exists and write PID file
      const configDir = getConfigDir();
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }
      await writeFile(getPidFile(), String(process.pid));

      if (verbose) {
        console.log(`[llm-inspector] Proxy started on port ${port}`);
        console.log(`[llm-inspector] Captures saved to ${captureDir}`);
        console.log(
          `[llm-inspector] Set ANTHROPIC_BASE_URL=http://localhost:${port} to capture Claude Code traffic`,
        );
      }

      resolve(server);
    });

    server.on("error", reject);
  });
}

/**
 * Save a captured request and its summary to disk.
 */
async function saveCapture(
  captured: CapturedRequest,
  captureDir: string,
): Promise<void> {
  const ts = captured.timestamp.replace(/[:.]/g, "-");
  const filename = `capture-${ts}-${Date.now()}.json`;
  const filepath = join(captureDir, filename);

  await writeFile(filepath, JSON.stringify(captured, null, 2));

  // Also save a component-size summary file
  const summary = computeSummary(captured.body);
  summary["total_body_size"] = captured.bodySize;
  if (captured.response?.usage) {
    if (captured.response.usage.input_tokens) {
      summary["response_input_tokens"] = captured.response.usage.input_tokens;
    }
    if (captured.response.usage.output_tokens) {
      summary["response_output_tokens"] = captured.response.usage.output_tokens;
    }
  }

  const summaryPath = filepath.replace(".json", ".summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
}
