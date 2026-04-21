/**
 * Transparent capture proxy for LLM API requests.
 * Uses raw Node.js http (no Express) to capture full HTTP bytes.
 * Intercepts requests, saves full payloads to disk,
 * forwards to upstream API, and streams responses back.
 */

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
  DEFAULT_PORT,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Tool mode infrastructure (preserved from original)
// ---------------------------------------------------------------------------

export type ToolMode = "observe" | "lean" | "on-demand";

const LEAN_TOOLS = new Set([
  "Bash", "Read", "Write", "Edit", "MultiEdit",
  "Glob", "Grep", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "NotebookEdit",
  "mcp__context7__resolve-library-id", "mcp__context7__get-library-docs",
]);

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

function makeStubSchema(name: HeavyToolName): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
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
    inputSchema: { type: "object", properties: {}, required: [] },
  };
}

const STUB_SCHEMA_MAP = new Map<string, ReturnType<typeof makeStubSchema>>();
for (const name of HEAVY_TOOL_NAMES) {
  STUB_SCHEMA_MAP.set(name, makeStubSchema(name));
}

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
    if (name.startsWith("mcp__") || LEAN_TOOLS.has(name)) {
      kept.push(tool);
    } else {
      stripped.push(name);
    }
  }

  if (stripped.length === 0) {
    return { modified: body, stripped: [] };
  }
  return { modified: { ...body, tools: kept }, stripped };
}

// ---------------------------------------------------------------------------
// On-demand re-issue infrastructure
// ---------------------------------------------------------------------------

interface RequestBuffer {
  originalBody: Record<string, unknown>;
  originalRawBody: Buffer;
  stubbedTools: Map<string, unknown>;
  sseChunks: string[];
  detectedStubbedTools: Set<string>;
  reIssuing: boolean;
  stubbedForwarded: boolean;
}

const requestBuffers = new Map<string, RequestBuffer>();
let requestIdCounter = 0;
function nextRequestId(): string {
  return `req-${Date.now()}-${++requestIdCounter}`;
}

function extractRequestId(body: Record<string, unknown>): string {
  if (typeof body.id === "string" && body.id.length > 0) {
    return body.id;
  }
  return nextRequestId();
}

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
  if (type === "content_block_start") {
    const cb = data.content_block as Record<string, unknown> | undefined;
    if (cb && cb.type === "tool_use") {
      const name = typeof cb.name === "string" ? cb.name : "";
      if (stubbedToolNames.has(name)) {
        detected.add(name);
      }
    }
  }
  return detected;
}

function scanBufferedSSEForStubbedTools(
  bufferedText: string,
  stubbedToolNames: Set<string>,
): Set<string> {
  const detected = new Set<string>();
  for (const line of bufferedText.split("\n")) {
    for (const name of parseSSEForStubbedTools(line, stubbedToolNames)) {
      detected.add(name);
    }
  }
  return detected;
}

function extractSSEUsage(
  bufferedText: string,
): { input_tokens?: number; output_tokens?: number } | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for (const line of bufferedText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]" || dataStr === "[done]") continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue;
    }

    const type = typeof data.type === "string" ? data.type : "";

    if (type === "message_start") {
      const msg = data.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      if (usage?.input_tokens != null) inputTokens = usage.input_tokens;
      if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
    }

    if (type === "message_delta") {
      const usage = data.usage as { output_tokens?: number } | undefined;
      if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
    }
  }

  if (inputTokens == null && outputTokens == null) return undefined;
  const result: { input_tokens?: number; output_tokens?: number } = {};
  if (inputTokens != null) result.input_tokens = inputTokens;
  if (outputTokens != null) result.output_tokens = outputTokens;
  return result;
}

async function reIssueWithFullSchema(
  originalBody: Record<string, unknown>,
  stubbedTools: Map<string, unknown>,
  upstream: URL,
  forwardHeaders: Record<string, string>,
): Promise<{ body: string; status: number }> {
  const fullTools = originalBody.tools
    ? (originalBody.tools as unknown[]).map((tool) => {
        const t = tool as Record<string, unknown>;
        const name = typeof t.name === "string" ? t.name : "";
        if (STUB_SCHEMA_MAP.has(name)) {
          const original = stubbedTools.get(name);
          if (original) return original;
        }
        return tool;
      })
    : [];

  const fullBody = { ...originalBody, tools: fullTools };
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

// ---------------------------------------------------------------------------
// Raw HTTP capture
// ---------------------------------------------------------------------------

/**
 * Build a raw HTTP request string from method/path/headers/body.
 */
function buildRawHttpRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): string {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("", "");
  return lines.join("\r\n") + body.toString("utf-8");
}

/**
 * Wrap response.write / response.end to capture raw bytes.
 */
class RawCaptureResponse {
  private chunks: Buffer[] = [];
  private rawChunks: string[] = [];
  private headerWritten = false;
  private statusCode = 200;
  private reason = "OK";
  private headers: Record<string, string | string[]> = {};

  constructor(
    private res: http.ServerResponse,
    private captureCb: (rawResponse: string) => void,
  ) {}

  setStatus(code: number, reason: string) {
    this.statusCode = code;
    this.reason = reason;
  }

  setHeader(key: string, value: string | string[]) {
    this.headers[key] = value;
  }

  write(chunk: Buffer | string): boolean {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.chunks.push(buf);
    this.rawChunks.push(buf.toString("utf-8"));
    if (!this.headerWritten) {
      this.res.writeHead(this.statusCode, this.headers);
      this.headerWritten = true;
    }
    const ok = this.res.write(buf);
    return ok;
  }

  end(chunk?: Buffer | string): void {
    if (chunk) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.chunks.push(buf);
      this.rawChunks.push(buf.toString("utf-8"));
    }
    if (!this.headerWritten) {
      this.res.writeHead(this.statusCode, this.headers);
      this.headerWritten = true;
    }
    const raw = this.buildRawResponse();
    this.captureCb(raw);
    this.res.end();
  }

  private buildRawResponse(): string {
    const lines = [`HTTP/1.1 ${this.statusCode} ${this.reason}`];
    for (const [k, v] of Object.entries(this.headers)) {
      if (Array.isArray(v)) {
        for (const val of v) lines.push(`${k}: ${val}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push("", "");
    return lines.join("\r\n") + this.rawChunks.join("");
  }

  getHeaderWritten(): boolean {
    return this.headerWritten;
  }

  getChunks(): Buffer[] {
    return this.chunks;
  }
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

export interface StartProxyOptions {
  port?: number;
  upstream?: string;
  verbose?: boolean;
  toolMode?: ToolMode;
}

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

  const server = http.createServer();

  server.on("request", async (req, res) => {
    const timestamp = new Date().toISOString();
    const method = req.method || "GET";
    const originalPath = req.url?.split("?")[0] || "/";
    const rawUrl = req.url || "";

    // Collect raw request bytes
    const reqChunks: Buffer[] = [];
    for await (const chunk of req) {
      reqChunks.push(chunk);
    }
    const rawRequestBody = Buffer.concat(reqChunks);

    // Parse headers
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      reqHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    const upstreamBase = upstreamOverride || "http://127.0.0.1:8000";
    const rewrittenPath = upstreamOverride
      ? "/claude" + (req.url || "/")
      : "/claude" + (req.url || "/");
    const upstream = new URL(rewrittenPath, upstreamBase);

    // Build raw HTTP request for capture
    const rawHttpRequest = buildRawHttpRequest(
      method,
      req.url || "/",
      reqHeaders,
      rawRequestBody,
    );

    // GET: passthrough without capture
    if (method === "GET") {
      if (verbose) {
        console.log(`[llm-inspector] GET ${originalPath} -> ${upstream.href}`);
      }
      const transport = upstream.protocol === "https:" ? https : http;
      const forwardHeaders = { ...reqHeaders };
      forwardHeaders["host"] = upstream.host;
      delete forwardHeaders["content-length"];

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
        res.status(502).end();
      });
      proxyReq.end();
      return;
    }

    // Parse body
    const bodyStr = rawRequestBody.toString("utf-8");
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      parsedBody = { _raw: bodyStr };
    }

    // Compute request body size
    const bodySize = rawRequestBody.length;

    // Build captured request
    const captured: CapturedRequest = {
      timestamp,
      method,
      path: originalPath,
      url: rawUrl,
      headers: redactHeaders(reqHeaders),
      body: parsedBody as CapturedRequest["body"],
      bodySize,
    };

    // Apply tool mode filtering
    let forwardBody = rawRequestBody;
    let strippedTools: string[] = [];
    let stubbedToolsMap = new Map<string, unknown>();
    let requestId = "";

    if (toolMode === "on-demand" && method === "POST") {
      const { modified, stubbedTools } = applyStubToolFilter(parsedBody);
      if (stubbedTools.size > 0) {
        stubbedToolsMap = stubbedTools;
        requestId = extractRequestId(parsedBody);
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBody.length;

        requestBuffers.set(requestId, {
          originalBody: parsedBody,
          originalRawBody: rawRequestBody,
          stubbedTools: stubbedToolsMap,
          sseChunks: [],
          detectedStubbedTools: new Set(),
          reIssuing: false,
          stubbedForwarded: false,
        });
      }
    }

    if (toolMode === "lean" && method === "POST") {
      const { modified, stripped } = applyLeanToolFilter(parsedBody);
      if (stripped.length > 0) {
        strippedTools = stripped;
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBody.length;
      }
    }

    if (verbose) {
      const model = parsedBody.model || "unknown";
      const note =
        strippedTools.length > 0
          ? ` [lean: stripped ${strippedTools.length} tools]`
          : stubbedToolsMap.size > 0
            ? ` [on-demand: stubbed ${stubbedToolsMap.size} tools]`
            : "";
      console.log(
        `[llm-inspector] ${method} ${originalPath} -> ${upstream.href} (${model}, ${bodySize}B -> ${forwardBody.length}B)${note}`,
      );
    }

    // Build forward headers
    const forwardHeaders: Record<string, string> = { ...reqHeaders };
    forwardHeaders["host"] = upstream.host;
    forwardHeaders["content-length"] = String(forwardBody.length);

    const transport = upstream.protocol === "https:" ? https : http;

    // Capture object for raw response
    let rawResponse = "";

    const proxyReq = transport.request(
      upstream.href,
      { method, headers: forwardHeaders },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode || 200;
        const contentType = (proxyRes.headers["content-type"] as string) || "";
        const isStreaming = contentType.includes("text/event-stream");

        const captureRes = new RawCaptureResponse(res, (raw) => {
          rawResponse = raw;
        });
        captureRes.setStatus(statusCode, proxyRes.reason || "OK");
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v !== undefined) captureRes.setHeader(k, v);
        }

        if (isStreaming && requestId && requestBuffers.has(requestId)) {
          // On-demand SSE mode
          const buf = requestBuffers.get(requestId)!;
          const stubbedNames = new Set([...buf.stubbedTools.keys()]);
          const allChunks: Buffer[] = [];

          proxyRes.on("data", (chunk: Buffer) => {
            allChunks.push(chunk);
            captureRes.write(chunk);
          });

          proxyRes.on("end", async () => {
            const fullText = Buffer.concat(allChunks).toString("utf-8");
            const detected = scanBufferedSSEForStubbedTools(fullText, stubbedNames);
            buf.sseChunks = allChunks.map((c) => c.toString("utf-8"));
            buf.detectedStubbedTools = detected;

            captured.request_raw = rawHttpRequest;

            if (detected.size > 0 && !buf.reIssuing) {
              buf.reIssuing = true;
              if (verbose) {
                console.log(
                  `[llm-inspector] on-demand: detected stubbed tools [${[...detected].join(", ")}] — re-issuing`,
                );
              }

              try {
                const { body: reIssuedBody, status: reIssuedStatus } =
                  await reIssueWithFullSchema(
                    buf.originalBody,
                    buf.stubbedTools,
                    upstream,
                    forwardHeaders,
                  );

                let reIssuedUsage:
                  | { input_tokens?: number; output_tokens?: number }
                  | undefined;
                try {
                  const reParsed = JSON.parse(reIssuedBody) as Record<string, unknown>;
                  reIssuedUsage = reParsed?.usage as
                    | { input_tokens?: number; output_tokens?: number }
                    | undefined;
                } catch {
                  reIssuedUsage = extractSSEUsage(reIssuedBody);
                }
                captured.response_raw = reIssuedBody;
                captured.response = {
                  status: reIssuedStatus,
                  body: reIssuedBody,
                  usage: reIssuedUsage,
                };
              } catch (reErr) {
                console.error(
                  `[llm-inspector] on-demand re-issue failed: ${reErr}. Falling back.`,
                );
                for (const sseChunk of buf.sseChunks) {
                  captureRes.write(Buffer.from(sseChunk));
                }
                captured.response = {
                  status: statusCode,
                  body: { _on_demand_reissue_failed: String(reErr) },
                };
              }
            } else {
              buf.stubbedForwarded = true;
              for (const sseChunk of buf.sseChunks) {
                captureRes.write(Buffer.from(sseChunk));
              }
              captured.response = { status: statusCode };
            }

            // end() triggers the callback that sets rawResponse, so call it BEFORE reading rawResponse
            captureRes.end();
            captured.response_raw = rawResponse;
            requestBuffers.delete(requestId);
            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
          });
        } else if (isStreaming) {
          // Normal SSE mode — stream + buffer for usage
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            captureRes.write(chunk);
          });
          proxyRes.on("end", () => {
            const fullBody = Buffer.concat(chunks).toString("utf-8");
            const usage = extractSSEUsage(fullBody);

            captured.request_raw = rawHttpRequest;
            captured.response = {
              status: statusCode,
              body: fullBody,
              usage,
            };

            if (verbose && usage) {
              console.log(
                `[llm-inspector] SSE usage: input=${usage.input_tokens ?? "?"} output=${usage.output_tokens ?? "?"}`,
              );
            }

            // end() triggers the callback that sets rawResponse, so call it BEFORE reading rawResponse
            captureRes.end();
            captured.response_raw = rawResponse;
            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
          });
        } else {
          // Non-streaming — buffer full response
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            captureRes.write(chunk);
          });
          proxyRes.on("end", () => {
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

            captured.request_raw = rawHttpRequest;
            captured.response = {
              status: statusCode,
              body: parsedResponse,
              usage,
            };
            // end() triggers the callback that sets rawResponse, so call it BEFORE reading rawResponse
            captureRes.end();
            captured.response_raw = rawResponse;
            saveCapture(captured, captureDir).catch((e) =>
              console.error(`[llm-inspector] Save error: ${e}`),
            );
          });
        }
      },
    );

    proxyReq.on("error", (err) => {
      console.error(`[llm-inspector] Upstream error: ${err.message}`);
      captured.response = { status: 502 };
      captured.request_raw = rawHttpRequest;
      saveCapture(captured, captureDir).catch(() => {});
      res.status(502).end();
    });

    proxyReq.write(forwardBody);
    proxyReq.end();
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.listen(port, async () => {
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

// ---------------------------------------------------------------------------
// Capture + summary saving
// ---------------------------------------------------------------------------

async function saveCapture(
  captured: CapturedRequest,
  captureDir: string,
): Promise<void> {
  const ts = captured.timestamp.replace(/[:.]/g, "-");
  const filename = `capture-${ts}-${Date.now()}.json`;
  const filepath = join(captureDir, filename);

  await writeFile(filepath, JSON.stringify(captured, null, 2));

  const summary: Record<string, number> = {};
  if (captured.body) {
    const body = captured.body as Record<string, unknown>;
    if (body.system) {
      const sysStr =
        typeof body.system === "string"
          ? body.system
          : JSON.stringify(body.system);
      summary["system_prompt"] = Buffer.byteLength(sysStr, "utf-8");
    }
    if (Array.isArray(body.tools)) {
      let builtinBytes = 0;
      let mcpBytes = 0;
      for (const tool of body.tools) {
        const size = Buffer.byteLength(JSON.stringify(tool), "utf-8");
        if (typeof (tool as Record<string, unknown>).name === "string" &&
            (tool as Record<string, unknown>).name.toString().startsWith("mcp__")) {
          mcpBytes += size;
        } else {
          builtinBytes += size;
        }
      }
      if (builtinBytes > 0) summary["builtin_tools"] = builtinBytes;
      if (mcpBytes > 0) summary["mcp_tools"] = mcpBytes;
    }
    if (Array.isArray(body.messages)) {
      let msgBytes = 0;
      for (const msg of body.messages) {
        msgBytes += Buffer.byteLength(JSON.stringify(msg), "utf-8");
      }
      summary["messages"] = msgBytes;
    }
  }
  summary["total_body_size"] = captured.bodySize || 0;
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
