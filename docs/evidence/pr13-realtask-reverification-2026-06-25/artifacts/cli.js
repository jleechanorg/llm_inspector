#!/usr/bin/env node
import {
  DEFAULT_PORT,
  cleanCaptures,
  ensureCaptureDir,
  estimateTokens,
  formatBytes,
  formatNumber,
  formatTable,
  getPidFile,
  loadCapturedRequests
} from "./chunk-YAUMN3RC.js";

// src/cli.ts
import { Command } from "commander";
import { existsSync, statSync } from "fs";
import { readFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";

// src/analyzer.ts
function analyzeRequest(captured) {
  const body = captured.body;
  const breakdown = [];
  let totalBytes = 0;
  let userMessageBytes = 0;
  if (body.system) {
    const sysStr = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const fullBytes = Buffer.byteLength(sysStr, "utf-8");
    totalBytes += fullBytes;
    const claudeMdRegex = /Contents of [^\n]*CLAUDE\.md[\s\S]*?(?=Contents of [^\n]*CLAUDE\.md|<system-reminder>|$)/g;
    const skillsRegex = /The following skills are available[\s\S]*?(?=<\/system-reminder>|$)/;
    const systemReminderRegex = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
    let instructionBytes = 0;
    let skillsBytes = 0;
    const claudeMatches = sysStr.match(claudeMdRegex);
    if (claudeMatches) {
      for (const match of claudeMatches) {
        instructionBytes += Buffer.byteLength(match, "utf-8");
      }
    }
    const skillsMatch = sysStr.match(skillsRegex);
    if (skillsMatch) {
      skillsBytes = Buffer.byteLength(skillsMatch[0], "utf-8");
    }
    const systemReminderMatches = sysStr.match(systemReminderRegex);
    let systemReminderTotalBytes = 0;
    if (systemReminderMatches) {
      for (const m of systemReminderMatches) {
        systemReminderTotalBytes += Buffer.byteLength(m, "utf-8");
      }
    }
    if (instructionBytes > 0 || skillsBytes > 0) {
      const baseBytes = fullBytes - instructionBytes - skillsBytes;
      if (baseBytes > 0) {
        breakdown.push({
          component: "System prompt",
          bytes: baseBytes,
          tokens: Math.ceil(baseBytes / 3.5),
          percentage: 0
        });
      }
      if (instructionBytes > 0) {
        breakdown.push({
          component: "CLAUDE.md / instructions",
          bytes: instructionBytes,
          tokens: Math.ceil(instructionBytes / 3.5),
          percentage: 0
        });
      }
      if (skillsBytes > 0) {
        breakdown.push({
          component: "Skills list",
          bytes: skillsBytes,
          tokens: Math.ceil(skillsBytes / 3.5),
          percentage: 0
        });
      }
    } else {
      breakdown.push({
        component: "System prompt",
        bytes: fullBytes,
        tokens: estimateTokens(sysStr),
        percentage: 0
      });
    }
  }
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const builtinTools = [];
    const mcpServers = /* @__PURE__ */ new Map();
    let builtinTotalBytes = 0;
    let mcpTotalBytes = 0;
    for (const tool of body.tools) {
      const toolStr = JSON.stringify(tool);
      const toolBytes = Buffer.byteLength(toolStr, "utf-8");
      const toolName = tool.name || tool.function?.name || "unnamed";
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        const serverName = parts.length >= 2 ? parts[1] : "unknown";
        if (!mcpServers.has(serverName)) {
          mcpServers.set(serverName, []);
        }
        mcpServers.get(serverName).push({
          name: toolName,
          bytes: toolBytes,
          tokens: estimateTokens(toolStr)
        });
        mcpTotalBytes += toolBytes;
      } else {
        builtinTools.push({
          name: toolName,
          bytes: toolBytes,
          tokens: estimateTokens(toolStr)
        });
        builtinTotalBytes += toolBytes;
      }
    }
    if (builtinTools.length > 0) {
      builtinTools.sort((a, b) => b.bytes - a.bytes);
      totalBytes += builtinTotalBytes;
      breakdown.push({
        component: `Built-in tool defs (${builtinTools.length})`,
        bytes: builtinTotalBytes,
        tokens: builtinTools.reduce((s, t) => s + t.tokens, 0),
        percentage: 0,
        details: builtinTools
      });
    }
    if (mcpServers.size > 0) {
      const mcpDetails = [];
      for (const [server, tools] of mcpServers) {
        const serverBytes = tools.reduce((s, t) => s + t.bytes, 0);
        const serverTokens = tools.reduce((s, t) => s + t.tokens, 0);
        mcpDetails.push({
          name: `${server} (${tools.length})`,
          bytes: serverBytes,
          tokens: serverTokens
        });
      }
      mcpDetails.sort((a, b) => b.bytes - a.bytes);
      const totalMcpToolCount = Array.from(mcpServers.values()).reduce(
        (s, arr) => s + arr.length,
        0
      );
      totalBytes += mcpTotalBytes;
      breakdown.push({
        component: `MCP tool defs (${totalMcpToolCount})`,
        bytes: mcpTotalBytes,
        tokens: mcpDetails.reduce((s, d) => s + d.tokens, 0),
        percentage: 0,
        details: mcpDetails
      });
    }
  }
  if (body.messages && Array.isArray(body.messages)) {
    let systemReminderBytes = 0;
    let userBytes = 0;
    let assistantBytes = 0;
    let toolResultBytes = 0;
    for (const msg of body.messages) {
      const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const msgBytes = Buffer.byteLength(contentStr, "utf-8");
      let isSystemReminder = false;
      if (typeof msg.content === "string") {
        if (msg.content.includes("<system-reminder>")) {
          isSystemReminder = true;
        }
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text?.includes("<system-reminder>")) {
            isSystemReminder = true;
          }
        }
      }
      if (isSystemReminder) {
        systemReminderBytes += msgBytes;
      } else if (msg.role === "user") {
        userBytes += msgBytes;
        userMessageBytes += msgBytes;
      } else if (msg.role === "assistant") {
        assistantBytes += msgBytes;
      } else if (msg.role === "tool") {
        toolResultBytes += msgBytes;
      } else {
        userBytes += msgBytes;
      }
    }
    if (systemReminderBytes > 0) {
      totalBytes += systemReminderBytes;
      breakdown.push({
        component: "System reminders (in messages)",
        bytes: systemReminderBytes,
        tokens: Math.ceil(systemReminderBytes / 3.5),
        percentage: 0
      });
    }
    if (userBytes > 0) {
      totalBytes += userBytes;
      breakdown.push({
        component: "User messages",
        bytes: userBytes,
        tokens: Math.ceil(userBytes / 3.5),
        percentage: 0
      });
    }
    if (assistantBytes > 0) {
      totalBytes += assistantBytes;
      breakdown.push({
        component: "Assistant messages",
        bytes: assistantBytes,
        tokens: Math.ceil(assistantBytes / 3.5),
        percentage: 0
      });
    }
    if (toolResultBytes > 0) {
      totalBytes += toolResultBytes;
      breakdown.push({
        component: "Tool results",
        bytes: toolResultBytes,
        tokens: Math.ceil(toolResultBytes / 3.5),
        percentage: 0
      });
    }
  }
  if (totalBytes === 0 && captured.bodySize > 0) {
    totalBytes = captured.bodySize;
    breakdown.push({
      component: "Request body (unstructured)",
      bytes: totalBytes,
      tokens: Math.ceil(totalBytes / 3.5),
      percentage: 100
    });
  }
  const estimatedTokens = breakdown.reduce((s, b) => s + b.tokens, 0);
  for (const b of breakdown) {
    b.percentage = totalBytes > 0 ? Math.round(b.bytes / totalBytes * 100) : 0;
  }
  return {
    totalBytes,
    estimatedTokens,
    breakdown,
    model: body.model,
    userMessageBytes
  };
}
async function analyzeCaptures(dir, options) {
  const requests = await loadCapturedRequests(dir, options);
  return requests.map(analyzeRequest);
}
function formatAnalysis(results) {
  if (results.length === 0) {
    return "No captures found. Start the proxy and make some API calls first.";
  }
  const lines = [];
  lines.push("=== LLM Inspector Analysis ===");
  lines.push(
    `Captured ${results.length} request${results.length > 1 ? "s" : ""}`
  );
  lines.push("");
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const model = result.model || "unknown";
    const tokensStr = result.estimatedTokens >= 1e3 ? `~${Math.round(result.estimatedTokens / 1e3)}K` : `~${result.estimatedTokens}`;
    lines.push(
      `Request ${i + 1}: ${model} (${formatNumber(result.totalBytes)} bytes, ${tokensStr} tokens)`
    );
    const rows = [["Component", "Bytes", "~Tokens", "%"]];
    for (const comp of result.breakdown) {
      const pctStr = comp.percentage < 1 ? "<1%" : `${comp.percentage}%`;
      rows.push([
        comp.component,
        formatNumber(comp.bytes),
        formatNumber(comp.tokens),
        pctStr
      ]);
      if (comp.details) {
        const topDetails = comp.details.slice(0, 5);
        for (const detail of topDetails) {
          const detailPct = result.totalBytes > 0 ? Math.round(detail.bytes / result.totalBytes * 100) : 0;
          const detailPctStr = detailPct < 1 ? "<1%" : `${detailPct}%`;
          rows.push([
            `  ${detail.name}`,
            formatNumber(detail.bytes),
            formatNumber(detail.tokens),
            detailPctStr
          ]);
        }
        if (comp.details.length > 5) {
          rows.push([
            `  ... and ${comp.details.length - 5} more`,
            "",
            "",
            ""
          ]);
        }
      }
    }
    rows.push([
      "TOTAL",
      formatNumber(result.totalBytes),
      formatNumber(result.estimatedTokens),
      "100%"
    ]);
    lines.push(formatTable(rows));
    lines.push("");
  }
  return lines.join("\n");
}

// src/cli.ts
var __filename = fileURLToPath(import.meta.url);
var program = new Command();
program.name("llm-inspector").description(
  "Capture and analyze LLM API request payloads \u2014 understand token usage"
).version("0.1.0");
program.command("start").description("Start the capture proxy").option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT)).option("-u, --upstream <url>", "Override upstream URL").option("--foreground", "Run in foreground (don't detach)").option(
  "--tool-mode <mode>",
  "Comma-separated features: observe (default), lean, on-demand, wafer-fix. E.g. --tool-mode lean,wafer-fix",
  "observe"
).action(async (opts) => {
  const port = parseInt(opts.port, 10);
  const pidFile = getPidFile();
  if (!opts.upstream) {
    let ccproxyRunning = false;
    try {
      execSync("lsof -ti:8000", { stdio: "pipe" });
      ccproxyRunning = true;
    } catch {
      ccproxyRunning = false;
    }
    if (!ccproxyRunning) {
      const ccproxyBin = process.env.CCPROXY_BIN || "ccproxy";
      try {
        const ccproxy = spawn(ccproxyBin, ["serve", "--port", "8000"], {
          detached: true,
          stdio: "ignore"
        });
        ccproxy.unref();
        await new Promise((resolve) => setTimeout(resolve, 800));
        console.log("ccproxy started on port 8000 (OAuth \u2192 Anthropic).");
      } catch {
        console.log(
          "Warning: could not start ccproxy. Make sure it is installed:\n  uv tool install ccproxy-api"
        );
        console.log(
          "Or pass --upstream <url> to forward directly to Anthropic."
        );
      }
    } else {
      console.log("ccproxy already running on port 8000.");
    }
  }
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
      process.kill(pid, 0);
      console.log(
        `Proxy already running (PID ${pid}). Use 'llm-inspector stop' first.`
      );
      return;
    } catch {
      await unlink(pidFile);
    }
  }
  if (opts.foreground) {
    const { startProxy } = await import("./proxy-HFWHUVD5.js");
    await startProxy({ port, upstream: opts.upstream, verbose: true, toolMode: opts.toolMode });
    return;
  }
  const child = spawn(
    process.execPath,
    [
      __filename,
      "_proxy-worker",
      "--port",
      String(port),
      ...opts.upstream ? ["--upstream", opts.upstream] : [],
      "--tool-mode",
      opts.toolMode || "observe"
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LLM_INSPECTOR_UPSTREAM: opts.upstream || "",
        LLM_INSPECTOR_TOOL_MODE: opts.toolMode || "observe"
      }
    }
  );
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const modeStr = opts.toolMode || "observe";
  const modeParts = modeStr.split(",").map((s) => s.trim());
  const modeNotes = [];
  if (modeParts.some((p) => p === "lean" || p === "lean-on-demand")) modeNotes.push("lean: MCP chrome tools stripped ~29KB/turn");
  if (modeParts.some((p) => p === "on-demand" || p === "lean-on-demand")) modeNotes.push("on-demand: heavy tools stubbed, re-issued on use");
  if (modeParts.includes("wafer-fix")) modeNotes.push("wafer-fix: input_tokens:0 patched with byte estimate");
  const toolModeNote = modeNotes.length > 0 ? ` [${modeNotes.join(" | ")}]` : " [observe: capture only]";
  console.log(`Capture proxy started on port ${port} (PID ${child.pid}).${toolModeNote}`);
  console.log("Chain: your tool \u2192 llm-inspector :9000 (capture) \u2192 ccproxy :8000 (OAuth) \u2192 Anthropic");
  console.log("");
  console.log("To capture Claude Code traffic, set:");
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${port}`);
  console.log(`  export ANTHROPIC_API_KEY=oauth-proxy`);
  console.log("");
  console.log("Then run: claude --print 'hello'");
  console.log("Then run: llm-inspector analyze");
});
program.command("_proxy-worker", { hidden: true }).option("-p, --port <port>", "Port", String(DEFAULT_PORT)).option("-u, --upstream <url>", "Upstream URL").option("--tool-mode <mode>", "Tool mode", "observe").action(async (opts) => {
  const { startProxy } = await import("./proxy-HFWHUVD5.js");
  await startProxy({
    port: parseInt(opts.port, 10),
    upstream: opts.upstream,
    verbose: true,
    toolMode: opts.toolMode
  });
});
program.command("stop").description("Stop the capture proxy").action(async () => {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) {
    console.log("No proxy is running (no PID file found).");
    return;
  }
  try {
    const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
    process.kill(pid, "SIGTERM");
    await unlink(pidFile);
    console.log(`Proxy stopped (PID ${pid}).`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await unlink(pidFile).catch(() => {
    });
    console.log(`Proxy process not found (may have already stopped): ${msg}`);
  }
});
program.command("analyze").description("Analyze captured requests and show token breakdown").option("--json", "Output as JSON").option("--last <n>", "Only analyze last N captures").option(
  "--sort <field>",
  "Sort by: size, tokens, time (default: time)",
  "time"
).option("--dir <path>", "Custom capture directory").action(async (opts) => {
  const dir = opts.dir || void 0;
  const last = opts.last ? parseInt(opts.last, 10) : void 0;
  const sort = opts.sort || "time";
  let results = await analyzeCaptures(dir, { last, sort });
  if (results.length === 0) {
    console.log(
      "No captures found. Start the proxy and make some API calls first."
    );
    console.log("");
    console.log("Quick start:");
    console.log("  llm-inspector start");
    console.log("  export ANTHROPIC_BASE_URL=http://localhost:9000");
    console.log("  # ... use Claude Code or any Anthropic API client ...");
    console.log("  llm-inspector analyze");
    return;
  }
  if (opts.sort === "size") {
    results.sort((a, b) => b.totalBytes - a.totalBytes);
  } else if (opts.sort === "tokens") {
    results.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  }
  if (opts.last) {
    const n = parseInt(opts.last, 10);
    if (n > 0 && n < results.length) {
      results = results.slice(-n);
    }
  }
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatAnalysis(results));
  }
});
program.command("clean").description("Remove all captured request files").option("--dir <path>", "Custom capture directory").action(async (opts) => {
  const dir = opts.dir || void 0;
  const count = await cleanCaptures(dir);
  if (count === 0) {
    console.log("No captures to clean.");
  } else {
    console.log(`Removed ${count} capture file${count !== 1 ? "s" : ""}.`);
  }
});
program.command("status").description("Check if proxy is running and show capture count").action(async () => {
  const pidFile = getPidFile();
  let running = false;
  let pid = null;
  if (existsSync(pidFile)) {
    try {
      pid = parseInt(await readFile(pidFile, "utf-8"), 10);
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }
  if (running) {
    console.log(`Proxy: RUNNING (PID ${pid})`);
  } else {
    console.log("Proxy: STOPPED");
  }
  const captureDir = await ensureCaptureDir();
  try {
    const files = await readdir(captureDir);
    const captures = files.filter(
      (f) => f.endsWith(".json") && !f.endsWith(".summary.json")
    );
    console.log(`Captures: ${captures.length} request(s) in ${captureDir}`);
    if (captures.length > 0) {
      let totalSize = 0;
      for (const f of files) {
        if (f.endsWith(".json")) {
          try {
            const stat = statSync(join(captureDir, f));
            totalSize += stat.size;
          } catch {
          }
        }
      }
      console.log(`Total capture size: ${formatBytes(totalSize)}`);
    }
  } catch {
    console.log("Captures: 0 (directory not found)");
  }
});
program.parse();
