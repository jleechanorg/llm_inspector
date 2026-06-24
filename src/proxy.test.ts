import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
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
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
            res.write("data: {\"type\": \"message\", \"content\": \"re-issued success\"}\n\n");
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
});

