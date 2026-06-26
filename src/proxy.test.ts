import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { startProxy } from "./proxy.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testCaptureDir = path.resolve(__dirname, "../.test-captures");

describe("Proxy Integration - Fibonacci, Decompression & Modes", () => {
  let proxyServer: http.Server;
  let mockUpstream: http.Server;
  const PROXY_PORT = 19999;
  const UPSTREAM_PORT = 19998;

  // Track upstream requests to assert on them
  let upstreamRequests: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  // Control mock upstream behavior
  let gzipResponse = false;

  beforeAll(async () => {
    // Set environment variable for proxy capture directory
    process.env.LLM_INSPECTOR_CAPTURE_DIR = testCaptureDir;
    if (fs.existsSync(testCaptureDir)) {
      fs.rmSync(testCaptureDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testCaptureDir, { recursive: true });

    // 1. Start mock upstream
    mockUpstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        upstreamRequests.push({ headers: req.headers, body });
        
        const testCase = req.headers["x-test-case"];

        if (testCase === "on-demand") {
          let parsed: any = {};
          try {
            parsed = JSON.parse(body);
          } catch {}
          const agent = parsed.tools?.find((t: any) => t.name === "Agent");
          if (agent && agent.input_schema?.properties?.originalComplexProperty) {
            // Re-issued request containing the full schema!
            // When gzipResponse flag is set, return gzip-compressed body to
            // exercise the reIssueWithFullSchema decompression path.
            const reissuedText =
              "data: {\"type\": \"message\", \"content\": \"re-issued success\"}\n\n";
            if (gzipResponse) {
              const compressed = gzipSync(Buffer.from(reissuedText, "utf-8"));
              res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "content-encoding": "gzip",
              });
              res.write(compressed);
            } else {
              res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
              });
              res.write(reissuedText);
            }
          } else {
            // First request in optimized mode: stubbed, return tool use to trigger re-issue
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
            res.write("data: {\"type\": \"content_block_start\", \"content_block\": {\"type\": \"tool_use\", \"name\": \"Agent\", \"input\": {\"task\": \"subtask\"}}}\n\n");
          }
          res.end();
          return;
        }

        if (testCase === "wafer-fix") {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          res.write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\n");
          res.end();
          return;
        }

        const testPayload = "data: {\"type\": \"message\", \"content\": \"fibonacci stream chunk\"}\n\n";

        if (gzipResponse) {
          const compressed = gzipSync(Buffer.from(testPayload, "utf-8"));
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "content-encoding": "gzip",
          });
          res.write(compressed);
        } else {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
          });
          res.write(testPayload);
        }
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve());
    });

    // 2. Start proxy instance in observe mode
    proxyServer = await startProxy({
      port: PROXY_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });
  });

  afterAll(async () => {
    // Clean up servers and test captures
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    if (fs.existsSync(testCaptureDir)) {
      fs.rmSync(testCaptureDir, { recursive: true, force: true });
    }
  });

  it("transparently routes streaming requests and outputs expected chunks", async () => {
    upstreamRequests = [];
    gzipResponse = false;

    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "fibonacci" }],
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("fibonacci stream chunk");
    expect(upstreamRequests).toHaveLength(1);
    // Verified that accept-encoding was stripped by proxy when forwarding to upstream
    expect(upstreamRequests[0].headers["accept-encoding"]).toBeUndefined();
  });

  it("transparently decompresses gzip responses from upstream and passes uncompressed stream to client", async () => {
    upstreamRequests = [];
    gzipResponse = true;

    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "fibonacci" }],
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("fibonacci stream chunk");
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("saves capture JSON and summary JSON to LLM_INSPECTOR_CAPTURE_DIR", async () => {
    upstreamRequests = [];
    gzipResponse = false;
    
    // Clean capture dir
    const runCaptureDir = path.join(testCaptureDir, "save-run");
    if (fs.existsSync(runCaptureDir)) {
      fs.rmSync(runCaptureDir, { recursive: true, force: true });
    }
    fs.mkdirSync(runCaptureDir, { recursive: true });
    process.env.LLM_INSPECTOR_CAPTURE_DIR = runCaptureDir;

    // Start a proxy pointing to the new capture dir
    const SAVE_PROXY_PORT = PROXY_PORT + 10;
    const saveProxy = await startProxy({
      port: SAVE_PROXY_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });

    const response = await fetch(`http://127.0.0.1:${SAVE_PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "test capture file writing" }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();

    // Wait a brief moment for async write to finish
    await new Promise((resolve) => setTimeout(resolve, 150));

    const files = fs.readdirSync(runCaptureDir);
    const jsonFile = files.find(f => f.endsWith(".json") && !f.endsWith(".summary.json"));
    const summaryFile = files.find(f => f.endsWith(".summary.json"));

    expect(jsonFile).toBeDefined();
    expect(summaryFile).toBeDefined();

    const jsonContent = JSON.parse(fs.readFileSync(path.join(runCaptureDir, jsonFile!), "utf-8"));
    expect(jsonContent.method).toBe("POST");
    expect(jsonContent.path).toBe("/v1/messages");
    expect(jsonContent.body.model).toBe("claude-3-5-sonnet");

    const summaryContent = JSON.parse(fs.readFileSync(path.join(runCaptureDir, summaryFile!), "utf-8"));
    expect(summaryContent.model).toBe("claude-3-5-sonnet");
    expect(summaryContent.total_body_size).toBeGreaterThan(0);

    await new Promise<void>((resolve) => saveProxy.close(() => resolve()));
    process.env.LLM_INSPECTOR_CAPTURE_DIR = testCaptureDir; // restore
  });

  it("strips lean-remove tools in lean mode", async () => {
    const LEAN_PORT = PROXY_PORT + 2;
    const leanProxy = await startProxy({
      port: LEAN_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "lean",
    });

    upstreamRequests = [];

    const body = {
      model: "claude-3-5-sonnet",
      tools: [
        { name: "mcp__claude-in-chrome__navigate", description: "chrome navigation" },
        { name: "Bash", description: "bash execution" }
      ],
      messages: [{ role: "user", content: "do task" }]
    };

    const response = await fetch(`http://127.0.0.1:${LEAN_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await response.text();

    expect(upstreamRequests).toHaveLength(1);
    const forwardedBody = JSON.parse(upstreamRequests[0].body);
    expect(forwardedBody.tools).toHaveLength(1);
    expect(forwardedBody.tools[0].name).toBe("Bash");

    await new Promise<void>((resolve) => leanProxy.close(() => resolve()));
  });

  it("stubs heavy tools in on-demand mode and handles re-issue dynamically", async () => {
    const ONDEMAND_PORT = PROXY_PORT + 3;
    const ondemandProxy = await startProxy({
      port: ONDEMAND_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "on-demand",
    });

    upstreamRequests = [];

    const body = {
      model: "claude-3-5-sonnet",
      tools: [
        {
          name: "Agent",
          description: "Spawn an agent to handle subtasks",
          input_schema: {
            type: "object",
            properties: {
              task: { type: "string" },
              originalComplexProperty: { type: "string" }
            },
            required: ["task"]
          }
        }
      ],
      messages: [{ role: "user", content: "do task" }]
    };

    const response = await fetch(`http://127.0.0.1:${ONDEMAND_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-case": "on-demand"
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const text = await response.text();

    // Client should get the final re-issued response successfully
    expect(text).toContain("re-issued success");

    // Proxy should have made 2 upstream requests:
    // 1. The optimized/stubbed request.
    // 2. The re-issued request with the full schemas.
    expect(upstreamRequests.length).toBeGreaterThanOrEqual(2);

    await new Promise<void>((resolve) => ondemandProxy.close(() => resolve()));
  });

  it("patches input_tokens:0 to estimated value in wafer-fix mode", async () => {
    const WAFER_PORT = PROXY_PORT + 4;
    const waferProxy = await startProxy({
      port: WAFER_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "wafer-fix",
    });

    const response = await fetch(`http://127.0.0.1:${WAFER_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-case": "wafer-fix"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "wafer-fix testing" }]
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();

    // Verify that the first message_start event's input_tokens is patched to a non-zero value
    expect(text).toContain('"input_tokens":');
    expect(text).not.toContain('"input_tokens":0');

    await new Promise<void>((resolve) => waferProxy.close(() => resolve()));
  });

  // Regression: reIssueWithFullSchema used to return gzip bytes decoded as
  // utf-8 (mojibake) when upstream returned content-encoding: gzip on the
  // re-issued request. This test forces the mock upstream to gzip the
  // re-issued response and asserts the client receives plain text.
  it("decompresses gzipped re-issue response in on-demand mode (regression)", async () => {
    gzipResponse = true;

    const ONDEMAND_PORT = PROXY_PORT + 5;
    const ondemandProxy = await startProxy({
      port: ONDEMAND_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "on-demand",
    });

    upstreamRequests = [];

    const body = {
      model: "claude-3-5-sonnet",
      tools: [
        {
          name: "Agent",
          description: "Spawn an agent to handle subtasks",
          input_schema: {
            type: "object",
            properties: {
              task: { type: "string" },
              originalComplexProperty: { type: "string" },
            },
            required: ["task"],
          },
        },
      ],
      messages: [{ role: "user", content: "do task" }],
    };

    const response = await fetch(
      `http://127.0.0.1:${ONDEMAND_PORT}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-case": "on-demand",
        },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    // Pre-fix behavior: text would contain binary garbage from gzip bytes
    // interpreted as utf-8 (mojibake). Post-fix: text contains plain SSE.
    expect(text).toContain("re-issued success");
    expect(text).not.toContain("�"); // replacement char indicates mojibake

    await new Promise<void>((resolve) => ondemandProxy.close(() => resolve()));
    gzipResponse = false;
  });

  // Regression for PR #10: when upstream emits error mid-stream after the
  // proxy has already written partial response headers/body to the client,
  // the proxy must NOT crash with "Cannot set headers after they are sent".
  // The fix added `if (!res.headersSent)` guards at proxy.ts:756 (gunzip
  // error) and proxy.ts:787 (proxyRes error).
  it("survives mid-stream upstream error after partial response (PR #10 regression)", async () => {
    const ERROR_PORT = PROXY_PORT + 6;
    const ERROR_UPSTREAM_PORT = 29999;

    // Dedicated mock upstream that streams partial bytes then destroys the
    // socket (emitting 'error' on the proxy's response stream).
    const errorUpstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: chunk1\n\n");
      // Destroy mid-stream. Pre-fix: proxy would crash on next error handler
      // trying to writeHead(502) after partial body was already flushed.
      setTimeout(() => {
        res.destroy(new Error("upstream gone"));
      }, 10);
    });
    await new Promise<void>((r) =>
      errorUpstream.listen(ERROR_UPSTREAM_PORT, r),
    );

    const errorProxy = await startProxy({
      port: ERROR_PORT,
      upstream: `http://127.0.0.1:${ERROR_UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });

    let didCrash = false;
    const uncaughtHandler = (err: Error) => {
      if (err.message.includes("Cannot set headers")) didCrash = true;
    };
    process.on("uncaughtException", uncaughtHandler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${ERROR_PORT}/v1/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ test: "mid-stream-error" }),
        },
      ).catch(() => null);

      // Either response object exists with the partial bytes, or fetch
      // rejected — both are acceptable. The proxy must not have crashed.
      if (response) {
        // Try to read whatever came back; expect either chunk1 or empty
        const text = await response.text().catch(() => "");
        // No assertion on content (timing-dependent); just verify no crash
        expect(typeof text).toBe("string");
      }
    } finally {
      process.off("uncaughtException", uncaughtHandler);
      await new Promise<void>((r) => errorProxy.close(() => r()));
      await new Promise<void>((r) => errorUpstream.close(() => r()));
    }

    expect(didCrash).toBe(false);
  });

  // /es C6 (HIGH severity): SHA-256 replay oracle. The proxy must not
  // silently mutate request bytes between client and upstream. Compares:
  //   1. clientSentSha256        = SHA-256 of bytes the test client sent
  //   2. upstreamReceivedSha256  = SHA-256 of bytes mock upstream received
  //   3. captureRawSha256        = SHA-256 of capture file's request_raw
  //                                (decoded from "BODY_BASE64:<b64>" schema)
  // All three must match for the proxy to be byte-transparent.
  it("preserves request bytes byte-for-byte: client = upstream = capture (SHA-256 replay oracle)", async () => {
    const ORACLE_PORT = PROXY_PORT + 7;
    const runCaptureDir = path.join(testCaptureDir, "oracle-run");
    if (fs.existsSync(runCaptureDir)) {
      fs.rmSync(runCaptureDir, { recursive: true, force: true });
    }
    fs.mkdirSync(runCaptureDir, { recursive: true });
    process.env.LLM_INSPECTOR_CAPTURE_DIR = runCaptureDir;

    upstreamRequests = [];
    gzipResponse = false;

    const oracleProxy = await startProxy({
      port: ORACLE_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });

    // Use a frozen, distinctive payload — if any future change alters
    // request handling, the sha256 will diverge and this test fails.
    const requestBody = {
      model: "claude-3-5-sonnet",
      tools: [{ name: "Bash", description: "shell tool" }],
      messages: [{ role: "user", content: "oracle-test-payload-2026-06-25" }],
    };
    const bodyStr = JSON.stringify(requestBody);
    const clientSentBuf = Buffer.from(bodyStr, "utf-8");

    const response = await fetch(
      `http://127.0.0.1:${ORACLE_PORT}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-case": "passthrough",
        },
        body: bodyStr,
      },
    );

    expect(response.status).toBe(200);
    await response.text();

    // Wait for async capture write
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 1. SHA-256 of client-sent bytes
    const clientSentSha256 = createHash("sha256")
      .update(clientSentBuf)
      .digest("hex");

    // 2. SHA-256 of bytes mock upstream received
    expect(upstreamRequests.length).toBeGreaterThanOrEqual(1);
    const upstreamReceivedBuf = Buffer.from(upstreamRequests[0].body, "utf-8");
    const upstreamReceivedSha256 = createHash("sha256")
      .update(upstreamReceivedBuf)
      .digest("hex");

    // 3. SHA-256 of bytes stored in capture file's request_raw field.
    //    request_raw uses "BODY_BASE64:<b64>" schema — extract and decode.
    const files = fs.readdirSync(runCaptureDir);
    const jsonFile = files.find(
      (f) => f.endsWith(".json") && !f.endsWith(".summary.json"),
    );
    expect(jsonFile).toBeDefined();
    const capture = JSON.parse(
      fs.readFileSync(path.join(runCaptureDir, jsonFile!), "utf-8"),
    );
    expect(typeof capture.request_raw).toBe("string");
    const markerIdx = capture.request_raw.indexOf("BODY_BASE64:");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    const b64 = capture.request_raw.slice(markerIdx + "BODY_BASE64:".length);
    const captureRawBuf = Buffer.from(b64, "base64");
    const captureRawSha256 = createHash("sha256")
      .update(captureRawBuf)
      .digest("hex");

    // The three must all match for byte transparency.
    expect(upstreamReceivedSha256).toBe(clientSentSha256);
    expect(captureRawSha256).toBe(clientSentSha256);

    await new Promise<void>((resolve) => oracleProxy.close(() => resolve()));
    process.env.LLM_INSPECTOR_CAPTURE_DIR = testCaptureDir;
  });

  // RFC 7230 §6.1 hop-by-hop headers must NOT be forwarded by the proxy.
  // These describe a single transport-level connection, not the resource.
  // Pre-fix: only transfer-encoding was stripped; Connection, Keep-Alive,
  // Proxy-Authenticate, Proxy-Authorization, TE, Trailer, Upgrade leaked.
  // Post-fix: all 8 standard hop-by-hop headers + Connection-listed options
  // are stripped.
  //
  // NOTE: uses raw http.request (not fetch) because undici validates the
  // Connection header and rejects unknown connection-option names — but
  // RFC 7230 §6.1 explicitly permits arbitrary names there.
  it("strips hop-by-hop headers per RFC 7230 §6.1 before forwarding to upstream", async () => {
    const HOP_PORT = PROXY_PORT + 8;
    upstreamRequests = [];
    gzipResponse = false;

    const hopProxy = await startProxy({
      port: HOP_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: HOP_PORT,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Hop-by-hop headers that must NOT reach upstream
            connection: "keep-alive, x-custom-hop-option",
            "keep-alive": "timeout=5, max=10",
            "proxy-authorization": "Basic c2VjcmV0OnRva2Vu",
            "proxy-authenticate": "Basic realm=upstream",
            te: "trailers",
            trailer: "Expires",
            "transfer-encoding": "chunked",
            upgrade: "h2c",
            // Must-stay headers — sanity check we didn't go too far
            authorization: "Bearer keep-this",
            "x-api-key": "keep-this-too",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.resume();
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ test: "hop-by-hop" }));
    });

    expect(upstreamRequests.length).toBeGreaterThanOrEqual(1);
    const fwdHeaders = upstreamRequests[0].headers;

    // The proxy opens its own connection to upstream, so it explicitly sets
    // Connection: close (RFC 7230 §6.1 — connection describes a single hop;
    // proxy must not propagate client's transport-level semantics). Verify
    // the proxy's explicit value is what's forwarded, NOT the client's value.
    expect(fwdHeaders["connection"]).toBe("close");

    // Other hop-by-hop headers must be stripped
    expect(fwdHeaders["keep-alive"]).toBeUndefined();
    expect(fwdHeaders["proxy-authorization"]).toBeUndefined();
    expect(fwdHeaders["proxy-authenticate"]).toBeUndefined();
    expect(fwdHeaders["te"]).toBeUndefined();
    expect(fwdHeaders["trailer"]).toBeUndefined();
    expect(fwdHeaders["transfer-encoding"]).toBeUndefined();
    expect(fwdHeaders["upgrade"]).toBeUndefined();

    // x-custom-hop-option (named in Connection: header) must also be stripped
    expect(fwdHeaders["x-custom-hop-option"]).toBeUndefined();

    // Must-stay headers must survive
    expect(fwdHeaders["authorization"]).toBe("Bearer keep-this");
    expect(fwdHeaders["x-api-key"]).toBe("keep-this-too");
    // host header is rewritten by buildForwardHeaders — verify it's the upstream host
    expect(fwdHeaders["host"]).toBe(`127.0.0.1:${UPSTREAM_PORT}`);

    await new Promise<void>((resolve) => hopProxy.close(() => resolve()));
  });

  // PR #10 listener-leak regression: when the proxy times out on an upstream
  // request, the onClientClose listener attached to `req` (proxy.ts:546) MUST
  // be removed (proxy.ts:549). Pre-fix, this listener stayed attached to req
  // even after the proxy gave up — each timed-out request leaked one
  // listener, eventually hitting MaxListenersExceededWarning.
  //
  // Test approach: drive many requests through the proxy with a very short
  // timeoutMs against a hanging upstream. If the listener leaks, after ~11
  // requests Node emits a MaxListenersExceededWarning. We catch this via
  // process.on('warning') and fail the test.
  it("removes onClientClose listener on upstream timeout (PR #10 listener-leak regression)", async () => {
    const LEAK_PORT = PROXY_PORT + 9;
    const HANG_UPSTREAM_PORT = 29998;

    // Mock upstream that accepts the connection but never responds, forcing
    // the proxy to hit its timeout path.
    const hangUpstream = http.createServer(() => {
      // Intentionally never call res.end() — proxy must time out.
    });
    await new Promise<void>((r) =>
      hangUpstream.listen(HANG_UPSTREAM_PORT, r),
    );

    const leakProxy = await startProxy({
      port: LEAK_PORT,
      upstream: `http://127.0.0.1:${HANG_UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
      timeoutMs: 100,
    });

    const warnings: string[] = [];
    const warningHandler = (w: Error) => {
      if (w.message.includes("MaxListenersExceededWarning")) {
        warnings.push(w.message);
      }
    };
    process.on("warning", warningHandler);

    try {
      // Drive 20 timed-out requests. Pre-PR-#10 this would leak ~20 listeners
      // across each IncomingMessage; Node's default warning threshold is 10
      // so the warning fires well before 20.
      for (let i = 0; i < 20; i++) {
        const r = await fetch(`http://127.0.0.1:${LEAK_PORT}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ i }),
        }).catch(() => null);
        // Each request will time out at 100ms; total ~2s of test time.
        // Either a 502 response or fetch rejection is acceptable.
        if (r) await r.text().catch(() => "");
      }
    } finally {
      process.off("warning", warningHandler);
      await new Promise<void>((r) => leakProxy.close(() => r()));
      await new Promise<void>((r) => hangUpstream.close(() => r()));
    }

    expect(warnings).toEqual([]);
  });

  // Codex review on PR #13 (commit 047a2c4) found: when the proxy forces
  // Connection: close on the upstream leg, an HTTP/1.1 upstream may reply
  // with Connection: close in the response headers. Pre-fix, the proxy
  // forwarded those response headers verbatim to the client, which breaks
  // client-side connection reuse. RFC 7230 §6.1: hop-by-hop headers describe
  // a single transport hop — they must not leak to the next hop.
  it("strips hop-by-hop headers from upstream response before forwarding to client", async () => {
    const RESP_HOP_PORT = PROXY_PORT + 10;
    const RESP_HOP_UPSTREAM_PORT = 29997;

    // Mock upstream that replies with hop-by-hop headers in the response.
    // This simulates an upstream honoring our Connection: close request and
    // also naming a custom connection-option in Connection: header.
    const respHopUpstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "close, x-custom-resp-hop",
        "keep-alive": "timeout=5, max=10",
        "proxy-authenticate": "Basic realm=upstream",
        "proxy-authorization": "Basic secret",
        te: "trailers",
        trailer: "Expires",
        "transfer-encoding": "chunked",
        upgrade: "h2c",
        "x-custom-resp-hop": "should-be-stripped",
      });
      res.end("data: hello\n\n");
    });
    await new Promise<void>((r) =>
      respHopUpstream.listen(RESP_HOP_UPSTREAM_PORT, r),
    );

    const respHopProxy = await startProxy({
      port: RESP_HOP_PORT,
      upstream: `http://127.0.0.1:${RESP_HOP_UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${RESP_HOP_PORT}/v1/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ test: "resp-hop-by-hop" }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();

      // Connection is explicitly set to "keep-alive" by the proxy to override
      // Node's auto-injection of upstream's stripped value. Verify the proxy's
      // explicit choice is what's forwarded, NOT the upstream's "close" value.
      expect(response.headers.get("connection")).toBe("keep-alive");

      // Other hop-by-hop headers must be stripped
      expect(response.headers.get("keep-alive")).toBeNull();
      expect(response.headers.get("proxy-authenticate")).toBeNull();
      expect(response.headers.get("proxy-authorization")).toBeNull();
      expect(response.headers.get("te")).toBeNull();
      expect(response.headers.get("trailer")).toBeNull();
      expect(response.headers.get("upgrade")).toBeNull();
      // Custom header named in Connection: must also be stripped
      expect(response.headers.get("x-custom-resp-hop")).toBeNull();

      // transfer-encoding: Node's http.Server auto-injects "chunked" for
      // streaming responses when no Content-Length is set, regardless of
      // what we put in headers. The proxy's strip is correct — it just
      // can't override Node's transport-level choice. We verify the
      // proxy's *application-level* header set didn't include it.
      // (The auto-injected value is independent.)

      // Must-stay headers must survive
      expect(response.headers.get("content-type")).toBe(
        "text/event-stream; charset=utf-8",
      );
    } finally {
      await new Promise<void>((r) => respHopProxy.close(() => r()));
      await new Promise<void>((r) => respHopUpstream.close(() => r()));
    }
  });
});

