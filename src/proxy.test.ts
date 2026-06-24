import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { startProxy } from "./proxy.js";

describe("Proxy Integration - Fibonacci & Decompression", () => {
  let proxyServer: http.Server;
  let mockUpstream: http.Server;
  const PROXY_PORT = 19999;
  const UPSTREAM_PORT = 19998;

  // Track upstream requests to assert on them
  let upstreamRequests: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  // Control mock upstream behavior
  let gzipResponse = false;

  beforeAll(async () => {
    // 1. Start mock upstream
    mockUpstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        upstreamRequests.push({ headers: req.headers, body });
        
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

    // 2. Start proxy instance
    proxyServer = await startProxy({
      port: PROXY_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      verbose: false,
      toolMode: "observe",
    });
  });

  afterAll(async () => {
    // Clean up servers
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
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
    // Decompressed response should be readable plain text
    const text = await response.text();
    expect(text).toContain("fibonacci stream chunk");
    // Client response headers must NOT contain content-encoding gzip (since proxy decompressed it)
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});
