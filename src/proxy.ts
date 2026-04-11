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
    return { baseUrl: envOverride, rewrittenPath: path };
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

export interface StartProxyOptions {
  port?: number;
  upstream?: string;
  verbose?: boolean;
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

    if (verbose) {
      const model = parsedBody.model || "unknown";
      console.log(
        `[llm-inspector] ${method} ${originalPath} -> ${upstream.href} (model: ${model}, ${bodySize} bytes)`,
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
    forwardHeaders["content-length"] = String(bodySize);

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

        if (isStreaming) {
          // Stream SSE data through to client in real time
          proxyRes.on("data", (chunk: Buffer) => {
            res.write(chunk);
          });
          proxyRes.on("end", () => {
            captured.response = { status: statusCode };
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

    proxyReq.write(rawBody);
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
