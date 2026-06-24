#!/usr/bin/env node
/**
 * Test script to reproduce and verify:
 * 1. Connection hang / missing re-issued response in on-demand mode.
 * 2. Duplicate chunk delivery in on-demand mode.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_PORT = 18889;
const UPSTREAM_PORT = 18888;
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../");
const CLI = resolve(REPO_ROOT, "dist/cli.js");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTest() {
  console.log("=== Starting Proxy Bug Reproduction Test ===\n");

  const upstreamServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const testCase = req.headers["x-test-case"];
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });

      if (body.includes("ORIGINAL AGENT DESCRIPTION")) {
        // Re-issued request
        res.write("data: {\"type\": \"message\", \"content\": \"re-issued success\"}\n\n");
      } else if (testCase === "stubbed") {
        // Original request for stubbed case
        res.write("data: {\"type\": \"content_block_start\", \"content_block\": {\"type\": \"tool_use\", \"name\": \"Agent\", \"input\": {\"task\": \"test task\"}}}\n\n");
      } else {
        // Normal case (no stubbed tools)
        res.write("data: {\"type\": \"message\", \"content\": \"normal response\"}\n\n");
      }
      res.end();
    });
  });

  await new Promise((resolve) => upstreamServer.listen(UPSTREAM_PORT, "127.0.0.1", resolve));
  console.log(`[mock-upstream] Listening on port ${UPSTREAM_PORT}`);

  const proxyProcess = spawn("node", [
    CLI, "_proxy-worker",
    "--port", String(PROXY_PORT),
    "--upstream", `http://127.0.0.1:${UPSTREAM_PORT}`,
    "--tool-mode", "on-demand",
  ], { stdio: "inherit" });

  await sleep(1500);
  console.log(`[proxy] Started on port ${PROXY_PORT}`);

  const requestBody = {
    model: "claude-3-5-sonnet-4-20250514",
    tools: [
      {
        name: "Agent",
        description: "ORIGINAL AGENT DESCRIPTION",
        input_schema: { type: "object", properties: { task: { type: "string" } } }
      }
    ],
    messages: [{ role: "user", content: "run task" }]
  };

  // Test Case 1: Normal Response (Should receive "normal response" exactly once)
  console.log("\n--- Test Case 1: Normal Response ---");
  const res1 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-case": "normal" },
    body: JSON.stringify(requestBody),
  });
  const text1 = await res1.text();
  console.log("Client received:", JSON.stringify(text1));

  // Test Case 2: Stubbed Response (Should receive "re-issued success")
  console.log("\n--- Test Case 2: Stubbed Response ---");
  const res2 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-case": "stubbed" },
    body: JSON.stringify(requestBody),
  });
  const text2 = await res2.text();
  console.log("Client received:", JSON.stringify(text2));

  // Cleanup
  proxyProcess.kill();
  upstreamServer.close();

  // Evaluate
  const occurrences1 = (text1.match(/normal response/g) || []).length;
  const duplicateBug = occurrences1 > 1;
  const reissueBug = !text2.includes("re-issued success");

  console.log("\n--- Evaluation ---");
  console.log(`Test Case 1 normal response occurrences: ${occurrences1} (Expected: 1)`);
  console.log(`Test Case 2 contains re-issued response: ${text2.includes("re-issued success") ? "YES" : "NO"} (Expected: YES)`);

  let failed = false;
  if (duplicateBug) {
    console.log("❌ BUG DETECTED: Duplicate chunk delivery (chunks printed twice).");
    failed = true;
  }
  if (reissueBug) {
    console.log("❌ BUG DETECTED: Missing re-issued response (client hangs/never gets it).");
    failed = true;
  }

  if (failed) {
    console.log("\n=== RESULT: FAIL (Bugs are present) ===");
    process.exit(1);
  } else {
    console.log("\n=== RESULT: PASS (No bugs detected) ===");
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
