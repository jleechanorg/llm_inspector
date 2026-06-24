#!/usr/bin/env node
/**
 * Automated Side-by-Side Test Runner for llm-inspector.
 * Compares Observe mode vs Lean+On-Demand mode.
 * Verifies behavior correctness and asserts token/byte savings.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_PORT = 18889;
const UPSTREAM_PORT = 18888;
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const TEST_CAPTURE_DIR = resolve(REPO_ROOT, ".test-captures");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanTestCaptures() {
  if (existsSync(TEST_CAPTURE_DIR)) {
    rmSync(TEST_CAPTURE_DIR, { recursive: true, force: true });
  }
}

// Target request with realistic heavy tools
const requestBody = {
  model: "claude-3-5-sonnet-4-20250514",
  tools: [
    {
      name: "Agent",
      description: "Spawn an autonomous sub-agent to handle a task. " + "X".repeat(800),
      input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] }
    },
    {
      name: "mcp__claude-in-chrome__computer",
      description: "Chrome browser automation tool that should be stripped. " + "Y".repeat(1500),
      input_schema: { type: "object", properties: { action: { type: "string" } } }
    },
    {
      name: "Bash",
      description: "Execute a bash command.",
      input_schema: { type: "object", properties: { command: { type: "string" } } }
    }
  ],
  messages: [{ role: "user", content: "run task" }]
};

async function runPhase(mode) {
  console.log(`\n--- Starting Phase: ${mode} mode ---`);
  cleanTestCaptures();

  // 1. Start Upstream
  let upstreamRequests = [];
  const upstreamServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      upstreamRequests.push(body);
      const testCase = req.headers["x-test-case"];
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });

      if (testCase === "normal") {
        res.write("data: {\"type\": \"message\", \"content\": \"plain text response\"}\n\n");
      } else if (testCase === "stubbed") {
        if (body.includes("XXXXXX")) {
          // Re-issued request containing full schema (or observer request with full schema)
          res.write("data: {\"type\": \"message\", \"content\": \"re-issued success\"}\n\n");
        } else {
          // First request in optimized mode: stubbed, return tool use to trigger re-issue
          res.write("data: {\"type\": \"content_block_start\", \"content_block\": {\"type\": \"tool_use\", \"name\": \"Agent\", \"input\": {\"task\": \"subtask\"}}}\n\n");
        }
      } else {
        res.write("data: {\"type\": \"message\", \"content\": \"plain text response\"}\n\n");
      }
      res.end();
    });
  });

  await new Promise((resolve) => upstreamServer.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

  // 2. Start Proxy
  const proxyProcess = spawn("node", [
    CLI, "_proxy-worker",
    "--port", String(PROXY_PORT),
    "--upstream", `http://127.0.0.1:${UPSTREAM_PORT}`,
    "--tool-mode", mode,
  ], {
    env: { ...process.env, LLM_INSPECTOR_CAPTURE_DIR: TEST_CAPTURE_DIR }
  });

  await sleep(1500);

  // 3. Make requests
  let clientResponses = [];

  // Case 1: Normal text response
  const res1 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-case": "normal" },
    body: JSON.stringify(requestBody),
  });
  clientResponses.push(await res1.text());

  // Case 2: Stubbed response (triggers re-issue)
  const res2 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-case": "stubbed" },
    body: JSON.stringify(requestBody),
  });
  clientResponses.push(await res2.text());

  // Wait for proxy to write captures
  await sleep(1000);

  // 4. Shutdown
  proxyProcess.kill();
  upstreamServer.close();
  await sleep(500);

  // 5. Analyze captures in the test directory
  const runInfo = spawn("node", [
    CLI, "analyze",
    "--json",
    "--dir", TEST_CAPTURE_DIR
  ]);

  let analysisJson = "";
  runInfo.stdout.on("data", (chunk) => analysisJson += chunk);
  await new Promise((resolve) => runInfo.on("close", resolve));

  const captures = JSON.parse(analysisJson);
  
  console.log(`[DEBUG - ${mode}] Analyzed ${captures.length} captures:`);
  for (let i = 0; i < captures.length; i++) {
    console.log(`  Capture ${i}: model=${captures[i].model}, totalBytes=${captures[i].totalBytes}, estimatedTokens=${captures[i].estimatedTokens}`);
    for (const comp of captures[i].breakdown) {
      console.log(`    - ${comp.component}: ${comp.bytes} B`);
    }
  }

  // Calculate statistics
  let totalBytes = 0;
  let toolBytes = 0;
  for (const cap of captures) {
    totalBytes += cap.totalBytes;
    for (const comp of cap.breakdown) {
      if (comp.component.startsWith("Built-in tool defs") || comp.component.startsWith("MCP tool defs")) {
        toolBytes += comp.bytes;
      }
    }
  }

  return {
    totalBytes,
    toolBytes,
    clientResponses,
    upstreamRequests,
    captures,
  };
}

async function runSideBySide() {
  console.log("=== Starting Side-by-Side Verification ===");

  const observer = await runPhase("observe");
  const optimized = await runPhase("lean,on-demand");

  console.log("\n=================================");
  console.log("=== COMPARISON AND VALIDATION ===");
  console.log("=================================");

  console.log(`\nObserver Phase:`);
  console.log(`  Total Request Bytes: ${observer.totalBytes.toLocaleString()} B`);
  console.log(`  Tool Definitions Bytes: ${observer.toolBytes.toLocaleString()} B`);

  console.log(`\nOptimized Phase:`);
  console.log(`  Total Request Bytes: ${optimized.totalBytes.toLocaleString()} B`);
  console.log(`  Tool Definitions Bytes: ${optimized.toolBytes.toLocaleString()} B`);

  console.log("\nObserver Client Responses:", JSON.stringify(observer.clientResponses));
  console.log("Optimized Client Responses:", JSON.stringify(optimized.clientResponses));

  // Assertions
  const overallSavingsPercent = ((observer.totalBytes - optimized.totalBytes) / observer.totalBytes * 100).toFixed(1);
  const toolSavingsPercent = ((observer.toolBytes - optimized.toolBytes) / observer.toolBytes * 100).toFixed(1);

  console.log(`\nSavings Breakdown:`);
  console.log(`  Payload size reduction: ${overallSavingsPercent}% (Requirement: >= 15%)`);
  console.log(`  Tool definition reduction: ${toolSavingsPercent}% (Requirement: >= 8%)`);

  let failed = false;

  if (parseFloat(overallSavingsPercent) < 15.0) {
    console.log("❌ FAIL: Overall payload reduction is below the 15% threshold.");
    failed = true;
  } else {
    console.log("✅ PASS: Overall payload reduction meets the threshold.");
  }

  if (parseFloat(toolSavingsPercent) < 8.0) {
    console.log("❌ FAIL: Tool definition reduction is below the 8% threshold.");
    failed = true;
  } else {
    console.log("✅ PASS: Tool definition reduction meets the threshold.");
  }

  // Check client responses for Case 1 (Duplicate chunks)
  // Observer Case 1 should have 1 normal chunk
  const obsOccurrences = (observer.clientResponses[0].match(/plain text/g) || []).length;
  const optOccurrences = (optimized.clientResponses[0].match(/plain text/g) || []).length;
  if (optOccurrences !== 1) {
    console.log(`❌ FAIL: Optimized normal response stream duplication detected! (occurrences: ${optOccurrences})`);
    failed = true;
  } else {
    console.log(`✅ PASS: Stream chunks delivered exactly once (no duplicate chunks).`);
  }

  // Check client responses for Case 2 (Re-issued success)
  if (!optimized.clientResponses[1].includes("re-issued success")) {
    console.log("❌ FAIL: Optimized stubbed response failed to receive the re-issued content (connection hang).");
    failed = true;
  } else {
    console.log("✅ PASS: Client successfully received the re-issued response.");
  }

  cleanTestCaptures();

  if (failed) {
    console.log("\n=== FINAL TEST RESULT: FAIL ===");
    process.exit(1);
  } else {
    console.log("\n=== FINAL TEST RESULT: PASS ===");
    process.exit(0);
  }
}

runSideBySide().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
