/**
 * Transparent capture proxy for LLM API requests.
 * Uses raw Node.js http (no Express) to capture full HTTP bytes.
 * Intercepts requests, saves full payloads to disk,
 * forwards to upstream API, and streams responses back.
 */

import http from "node:http";
import https from "node:https";
import { createGunzip } from "node:zlib";
import type { Readable } from "node:stream";
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
import {
  STUB_SCHEMA_MAP,
  applyLeanFilter,
  applyOnDemandFilter,
  applyLeanOnDemandFilter,
  parseModeFeatures,
  WaferFixPatcher,
  ReadSizeGuard,
  estimateInputTokens,
} from "./filters.js";

// ---------------------------------------------------------------------------
// Tool mode infrastructure
// ---------------------------------------------------------------------------

// Comma-separated feature string: "lean", "on-demand", "wafer-fix", or combos
// Legacy compound: "lean-on-demand" = "lean,on-demand"
export type ToolMode = string;

// (filter logic lives in filters.ts — imported above)

function applyStubToolFilter(body: Record<string, unknown>) {
  return applyOnDemandFilter(body);
}

function applyLeanToolFilter(body: Record<string, unknown>) {
  return applyLeanFilter(body);
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

/**
 * Build the headers sent upstream to the real API.
 *
 * Centralizes the three header-normalization rules that used to be open-coded
 * at every call site:
 *   1. Replace `host` with the upstream's host (never leak the inspector's port).
 *   2. For methods that carry a body (POST/PUT/PATCH), set `content-length`
 *      to the byte length of the body we are about to send. For methods
 *      without a body, strip any incoming `content-length` so a downstream
 *      proxy cannot read a stale value.
 *   3. Strip `accept-encoding` and `transfer-encoding`. We always request
 *      identity-encoded responses so we can capture raw bytes; the chunked
 *      + content-length conflict from `transfer-encoding` is a known cause
 *      of the response-side decompression bug.
 */
function buildForwardHeaders(
  source: Record<string, string>,
  forwardBody: Buffer,
  options: { method: string; upstreamHost: string },
): Record<string, string> {
  const headers: Record<string, string> = { ...source };
  headers["host"] = options.upstreamHost;
  const method = options.method.toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    headers["content-length"] = String(forwardBody.length);
  } else {
    delete headers["content-length"];
  }
  delete headers["accept-encoding"];
  delete headers["transfer-encoding"];
  return headers;
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
  clientReq?: http.IncomingMessage,
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
  const headers = buildForwardHeaders(forwardHeaders, bodyBuf, {
    method: "POST",
    upstreamHost: upstream.host,
  });

  return new Promise((resolve, reject) => {
    const transport = upstream.protocol === "https:" ? https : http;
    const req = transport.request(
      upstream.href,
      { method: "POST", headers, timeout: 120000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ body, status: res.statusCode || 200 });
        });
        res.on("error", (err) => {
          res.destroy();
          reject(err);
        });
        res.on("close", () => {
          res.destroy();
        });
      },
    );
    const onClientClose = () => {
      req.destroy();
    };
    if (clientReq) {
      clientReq.on("close", onClientClose);
    }
    req.on("timeout", () => {
      if (clientReq) {
        clientReq.off("close", onClientClose);
      }
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", (err) => {
      if (clientReq) {
        clientReq.off("close", onClientClose);
      }
      reject(err);
    });
    req.on("close", () => {
      if (clientReq) {
        clientReq.off("close", onClientClose);
      }
    });
    req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Raw HTTP capture
// ---------------------------------------------------------------------------

/**
 * Build a raw HTTP request string from method/path/headers/body.
 *
 * The body is captured as a base64-encoded marker line (`BODY_BASE64:<b64>`)
 * rather than decoded as UTF-8. This preserves binary-safe fidelity for
 * request bodies that may arrive gzip- or brotli-compressed — decoding those
 * bytes as UTF-8 yields replacement-character mojibake and silently corrupts
 * the captured payload.
 *
 * Schema of the returned string:
 *   "<headers>\r\n\r\nBODY_BASE64:<base64-of-body>"
 *
 * Downstream readers split on the trailing `\r\n\r\nBODY_BASE64:` and
 * base64-decode the suffix to recover the original raw body bytes.
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
  return lines.join("\r\n") + "BODY_BASE64:" + body.toString("base64");
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
  const toolModeStr: string =
    options.toolMode ||
    (process.env.LLM_INSPECTOR_TOOL_MODE as string | undefined) ||
    "observe";
  const modes = parseModeFeatures(toolModeStr);

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
    // ccproxy-api expects /claude prefix; direct upstreams (Wafer, Anthropic) don't
    const rewrittenPath = upstreamOverride
      ? (req.url || "/")
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
      const forwardHeaders = buildForwardHeaders(reqHeaders, Buffer.alloc(0), {
        method: "GET",
        upstreamHost: upstream.host,
      });

      const proxyReq = transport.request(
        upstream.href,
        { method: "GET", headers: forwardHeaders, timeout: 120000 },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

          proxyRes.on("error", (err) => {
            console.error(`[llm-inspector] Proxy response error: ${err.message}`);
            proxyRes.destroy();
            res.destroy();
          });
          proxyRes.on("close", () => {
            proxyRes.destroy();
          });

          proxyRes.pipe(res);
        },
      );
      const onClientClose = () => {
        proxyReq.destroy();
      };
      req.on("close", onClientClose);

      proxyReq.on("timeout", () => {
        req.off("close", onClientClose);
        proxyReq.destroy(new Error("Request timeout"));
      });
      proxyReq.on("error", (err) => {
        req.off("close", onClientClose);
        console.error(`[llm-inspector] Proxy error: ${err.message}`);
        if (!res.writableEnded) {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain" }).end(
              `Bad Gateway: upstream error: ${err.message}`,
            );
          } else {
            res.end();
          }
        }
      });
      proxyReq.on("close", () => {
        req.off("close", onClientClose);
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

    if (modes.onDemand && !modes.lean && method === "POST") {
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

    if (modes.lean && !modes.onDemand && method === "POST") {
      const { modified, stripped } = applyLeanToolFilter(parsedBody);
      if (stripped.length > 0) {
        strippedTools = stripped;
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBody.length;
      }
    }

    if (modes.lean && modes.onDemand && method === "POST") {
      const { modified, stripped, stubbedTools } = applyLeanOnDemandFilter(parsedBody);
      if (stripped.length > 0 || stubbedTools.size > 0) {
        strippedTools = stripped;
        if (stubbedTools.size > 0) {
          stubbedToolsMap = stubbedTools;
          requestId = extractRequestId(parsedBody);
          requestBuffers.set(requestId, {
            originalBody: modified,
            originalRawBody: rawRequestBody,
            stubbedTools: stubbedToolsMap,
            sseChunks: [],
            detectedStubbedTools: new Set(),
            reIssuing: false,
            stubbedForwarded: false,
          });
        }
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBody.length;
      }
    }

    // Create wafer-fix patcher if enabled (patches input_tokens:0 → estimated value)
    // Use rawRequestBody (pre-lean) so the estimate matches Claude Code's internal
    // context tracking, which sees the full body including tool schemas.
    const patcher = modes.waferFix
      ? new WaferFixPatcher(estimateInputTokens(rawRequestBody.length))
      : null;

    // Layer 3: Model-aware auto-lean — detect GLM models and force lean mode
    // GLM-5.1 ignores file-read discipline, so stripping Chrome tools (~29KB)
    // reduces the request payload it must process, preventing context bloat.
    const modelStr = (parsedBody.model as string) || "";
    const isGLMModel = /GLM/i.test(modelStr);
    if (isGLMModel && !modes.lean && method === "POST") {
      const { modified, stripped: autoStripped } = applyLeanFilter(parsedBody);
      if (autoStripped.length > 0) {
        strippedTools = autoStripped;
        const newBodyStr = JSON.stringify(modified);
        forwardBody = Buffer.from(newBodyStr, "utf-8");
        captured.body = modified as CapturedRequest["body"];
        captured.bodySize = forwardBody.length;
        if (verbose) {
          console.log(
            `[llm-inspector] auto-lean: detected GLM model "${modelStr}", stripped ${autoStripped.length} tools`,
          );
        }
      }
    }

    // Layer 2: ReadSizeGuard — truncates oversized tool_result content in SSE
    // Activates when wafer-fix mode is on OR when the model is a GLM variant.
    const readGuard = new ReadSizeGuard(modes.waferFix || isGLMModel);

    if (verbose) {
      const model = parsedBody.model || "unknown";
      const toolNote =
        strippedTools.length > 0 && stubbedToolsMap.size > 0
          ? ` [lean+on-demand: stripped ${strippedTools.length}, stubbed ${stubbedToolsMap.size}]`
          : strippedTools.length > 0
            ? ` [lean: stripped ${strippedTools.length} tools]`
            : stubbedToolsMap.size > 0
              ? ` [on-demand: stubbed ${stubbedToolsMap.size} tools]`
              : "";
      const waferNote = patcher ? ` [wafer-fix: est ${estimateInputTokens(forwardBody.length)} tokens]` : "";
      const guardNote = (modes.waferFix || isGLMModel) ? " [read-size-guard: on]" : "";
      const note = toolNote + waferNote + guardNote;
      console.log(
        `[llm-inspector] ${method} ${originalPath} -> ${upstream.href} (${model}, ${bodySize}B -> ${forwardBody.length}B)${note}`,
      );
    }

    // Build forward headers
    const forwardHeaders = buildForwardHeaders(reqHeaders, forwardBody, {
      method,
      upstreamHost: upstream.host,
    });

    const transport = upstream.protocol === "https:" ? https : http;

    // Capture object for raw response
    let rawResponse = "";

    const proxyReq = transport.request(
      upstream.href,
      { method, headers: forwardHeaders, timeout: 120000 },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode || 200;
        const contentType = (proxyRes.headers["content-type"] as string) || "";
        const isStreaming = contentType.includes("text/event-stream");

        const captureRes = new RawCaptureResponse(res, (raw) => {
          rawResponse = raw;
        });
        captureRes.setStatus(statusCode, (proxyRes as unknown as { reason?: string }).reason || "OK");

        // Detect gzip on the response. Some upstreams ignore accept-encoding
        // stripping on the request side and still send compressed bytes; without
        // gunzip the client sees gzip-encoded bytes labelled content-encoding: gzip
        // and explodes with "Decompression error: ZlibError" + retry storm.
        // TODO(brotli): add `br` (and `deflate`) support here if upstreams start
        // returning brotli; for now we only handle gzip.
        const responseEncoding = (
          proxyRes.headers["content-encoding"] as string | undefined
        )?.toLowerCase();
        const isGzip = responseEncoding === "gzip";

        // Build the headers we forward to the client. When gzip, drop
        // content-encoding (we'll decompress) and content-length (will differ).
        // `transfer-encoding: chunked` (if present) is preserved automatically.
        const forwardResponseHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v === undefined) continue;
          if (isGzip && (k === "content-encoding" || k === "content-length")) {
            continue;
          }
          forwardResponseHeaders[k] = v;
        }
        for (const [k, v] of Object.entries(forwardResponseHeaders)) {
          captureRes.setHeader(k, v);
        }

        let upstreamFinished = false;
        let proxyResFinished = false;

        proxyRes.on("end", () => {
          proxyResFinished = true;
        });

        // The body source the three branches below will listen to. Defaults to
        // proxyRes (passthrough); becomes the gunzip stream when we decompress.
        let bodySource: Readable = proxyRes;
        let gunzipStream: Readable | null = null;
        if (isGzip) {
          const gunzip = createGunzip();
          gunzipStream = gunzip;
          gunzip.on("error", (gzErr) => {
            if (upstreamFinished) return;
            upstreamFinished = true;
            // Upstream claimed gzip but the bytes aren't actually gzip, or the
            // stream was truncated. Mirror the proxyReq.on("error") 502 pattern
            // so the client gets a clean failure instead of a hanging socket.
            console.error(
              `[llm-inspector] Gunzip error: ${gzErr.message}. Returning 502.`,
            );
            gunzip.destroy();
            proxyRes.destroy();
            try {
              captured.response = { status: 502 };
              captured.request_raw = rawHttpRequest;
              saveCapture(captured, captureDir).catch(() => {});
            } catch {
              /* ignore capture save errors during error path */
            }
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain" }).end(
                `Bad Gateway: response decompression failed: ${gzErr.message}`,
              );
            } else {
              res.end();
            }
          });
          gunzip.on("close", () => {
            if (upstreamFinished) return;
            upstreamFinished = true;
            gunzip.destroy();
            proxyRes.destroy();
            if (!res.writableEnded) {
              res.end();
            }
          });
          proxyRes.pipe(gunzip);
          bodySource = gunzip;
        }

        // Listeners for proxyRes
        proxyRes.on("error", (err) => {
          if (proxyResFinished || upstreamFinished) return;
          upstreamFinished = true;
          console.error(`[llm-inspector] Upstream response error: ${err.message}`);
          proxyRes.destroy();
          if (gunzipStream) {
            gunzipStream.destroy();
          }
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain" }).end(
                `Bad Gateway: upstream response error: ${err.message}`,
              );
            } else {
              res.end();
            }
          }
        });
        proxyRes.on("close", () => {
          if (proxyResFinished || upstreamFinished) return;
          upstreamFinished = true;
          proxyRes.destroy();
          if (gunzipStream) {
            gunzipStream.destroy();
          }
          if (!res.writableEnded) {
            res.end();
          }
        });

        if (isStreaming && requestId && requestBuffers.has(requestId)) {
          // On-demand SSE mode
          const buf = requestBuffers.get(requestId)!;
          const stubbedNames = new Set([...buf.stubbedTools.keys()]);
          const allChunks: Buffer[] = [];

          bodySource.on("data", (chunk: Buffer) => {
            let bufs = patcher ? patcher.process(chunk) : [chunk];
            bufs = bufs.flatMap((b) => readGuard.process(b));
            for (const c of bufs) {
              allChunks.push(c);
            }
          });

          bodySource.on("end", async () => {
            upstreamFinished = true;
            if (patcher) {
              for (const c of patcher.flush()) {
                const guarded = readGuard.process(c);
                for (const g of guarded) {
                  allChunks.push(g);
                }
              }
            }
            for (const c of readGuard.flush()) {
              allChunks.push(c);
            }
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
                    req,
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
                
                // Write the re-issued response back to the client!
                captureRes.write(Buffer.from(reIssuedBody));

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
          bodySource.on("data", (chunk: Buffer) => {
            let bufs = patcher ? patcher.process(chunk) : [chunk];
            bufs = bufs.flatMap((b) => readGuard.process(b));
            for (const c of bufs) {
              chunks.push(c);
              captureRes.write(c);
            }
          });
          bodySource.on("end", () => {
            upstreamFinished = true;
            if (patcher) {
              for (const c of patcher.flush()) {
                const guarded = readGuard.process(c);
                for (const g of guarded) {
                  chunks.push(g);
                  captureRes.write(g);
                }
              }
            }
            for (const c of readGuard.flush()) {
              chunks.push(c);
              captureRes.write(c);
            }
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
          bodySource.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            captureRes.write(chunk);
          });
          bodySource.on("end", () => {
            upstreamFinished = true;
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

    const onClientClose = () => {
      proxyReq.destroy();
    };
    req.on("close", onClientClose);

    proxyReq.on("timeout", () => {
      req.off("close", onClientClose);
      proxyReq.destroy(new Error("Request timeout"));
    });

    proxyReq.on("error", (err) => {
      req.off("close", onClientClose);
      console.error(`[llm-inspector] Upstream error: ${err.message}`);
      captured.response = { status: 502 };
      captured.request_raw = rawHttpRequest;
      saveCapture(captured, captureDir).catch(() => {});
      if (!res.writableEnded) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" }).end(
            `Bad Gateway: upstream error: ${err.message}`,
          );
        } else {
          res.end();
        }
      }
    });

    proxyReq.on("close", () => {
      req.off("close", onClientClose);
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

  const summary: Record<string, number | string> = {};
  if (captured.body) {
    const body = captured.body as Record<string, unknown>;
    if (body.model) summary["model"] = body.model as string;
    if (/GLM/i.test(String(body.model || ""))) summary["session_type"] = "wafer";
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
        const t = tool as Record<string, unknown>;
        const size = Buffer.byteLength(JSON.stringify(t), "utf-8");
        if (typeof t.name === "string" && t.name.startsWith("mcp__")) {
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
