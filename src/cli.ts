#!/usr/bin/env node

/**
 * llm-inspector CLI — capture and analyze LLM API request payloads.
 *
 * Commands:
 *   start   - Start the capture proxy (background by default)
 *   stop    - Stop the capture proxy
 *   analyze - Analyze captured requests and show token breakdown
 *   clean   - Remove all captured request files
 *   status  - Check if proxy is running, show capture count
 */

import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { readFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  DEFAULT_PORT,
  getPidFile,
  ensureCaptureDir,
  cleanCaptures,
  formatBytes,
} from "./utils.js";
import { analyzeCaptures, formatAnalysis } from "./analyzer.js";

const __filename = fileURLToPath(import.meta.url);

const program = new Command();

program
  .name("llm-inspector")
  .description(
    "Capture and analyze LLM API request payloads — understand token usage",
  )
  .version("0.1.0");

// ── start ──────────────────────────────────────────────────────────────────
program
  .command("start")
  .description("Start the capture proxy")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .option("-u, --upstream <url>", "Override upstream URL")
  .option("--foreground", "Run in foreground (don't detach)")
  .option(
    "--tool-mode <mode>",
    "Comma-separated features: observe (default), lean, on-demand, wafer-fix. E.g. --tool-mode lean,wafer-fix",
    "observe",
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const pidFile = getPidFile();

    // ── Start ccproxy if not already running ────────────────────────────────
    if (!opts.upstream) {
      let ccproxyRunning = false;
      try {
        // Check if port 8000 is in use (ccproxy's default)
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
            stdio: "ignore",
          });
          ccproxy.unref();
          await new Promise((resolve) => setTimeout(resolve, 800));
          console.log("ccproxy started on port 8000 (OAuth → Anthropic).");
        } catch {
          console.log(
            "Warning: could not start ccproxy. Make sure it is installed:\n  uv tool install ccproxy-api",
          );
          console.log(
            "Or pass --upstream <url> to forward directly to Anthropic.",
          );
        }
      } else {
        console.log("ccproxy already running on port 8000.");
      }
    }

    // Check if already running
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
        process.kill(pid, 0); // throws if process doesn't exist
        console.log(
          `Proxy already running (PID ${pid}). Use 'llm-inspector stop' first.`,
        );
        return;
      } catch {
        // Stale PID file — remove it
        await unlink(pidFile);
      }
    }

    if (opts.foreground) {
      // Run in foreground (blocks)
      const { startProxy } = await import("./proxy.js");
      await startProxy({ port, upstream: opts.upstream, verbose: true, toolMode: opts.toolMode });
      return;
    }

    // Spawn a detached child process running the internal worker command
    // (spawn rather than fork — fork doesn't work cleanly with ESM modules)
    const child = spawn(
      process.execPath,
      [
        __filename,
        "_proxy-worker",
        "--port",
        String(port),
        ...(opts.upstream ? ["--upstream", opts.upstream] : []),
        "--tool-mode",
        opts.toolMode || "observe",
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          LLM_INSPECTOR_UPSTREAM: opts.upstream || "",
          LLM_INSPECTOR_TOOL_MODE: opts.toolMode || "observe",
        },
      },
    );

    child.unref();

    // Give it a moment to bind the port
    await new Promise((resolve) => setTimeout(resolve, 500));

    const modeStr: string = opts.toolMode || "observe";
    const modeParts = modeStr.split(",").map((s: string) => s.trim());
    const modeNotes: string[] = [];
    if (modeParts.some((p: string) => p === "lean" || p === "lean-on-demand")) modeNotes.push("lean: MCP chrome tools stripped ~29KB/turn");
    if (modeParts.some((p: string) => p === "on-demand" || p === "lean-on-demand")) modeNotes.push("on-demand: heavy tools stubbed, re-issued on use");
    if (modeParts.includes("wafer-fix")) modeNotes.push("wafer-fix: input_tokens:0 patched with byte estimate");
    const toolModeNote = modeNotes.length > 0 ? ` [${modeNotes.join(" | ")}]` : " [observe: capture only]";
    console.log(`Capture proxy started on port ${port} (PID ${child.pid}).${toolModeNote}`);
    console.log("Chain: your tool → llm-inspector :9000 (capture) → ccproxy :8000 (OAuth) → Anthropic");
    console.log("");
    console.log("To capture Claude Code traffic, set:");
    console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log(`  export ANTHROPIC_API_KEY=oauth-proxy`);
    console.log("");
    console.log("Then run: claude --print 'hello'");
    console.log("Then run: llm-inspector analyze");
  });

// ── Internal worker process (not user-facing) ─────────────────────────────
program
  .command("_proxy-worker", { hidden: true })
  .option("-p, --port <port>", "Port", String(DEFAULT_PORT))
  .option("-u, --upstream <url>", "Upstream URL")
  .option("--tool-mode <mode>", "Tool mode", "observe")
  .action(async (opts) => {
    const { startProxy } = await import("./proxy.js");
    await startProxy({
      port: parseInt(opts.port, 10),
      upstream: opts.upstream,
      verbose: true,
      toolMode: opts.toolMode,
    });
  });

// ── stop ───────────────────────────────────────────────────────────────────
program
  .command("stop")
  .description("Stop the capture proxy")
  .action(async () => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await unlink(pidFile).catch(() => {});
      console.log(`Proxy process not found (may have already stopped): ${msg}`);
    }
  });

// ── analyze ────────────────────────────────────────────────────────────────
program
  .command("analyze")
  .description("Analyze captured requests and show token breakdown")
  .option("--json", "Output as JSON")
  .option("--last <n>", "Only analyze last N captures")
  .option(
    "--sort <field>",
    "Sort by: size, tokens, time (default: time)",
    "time",
  )
  .option("--dir <path>", "Custom capture directory")
  .action(async (opts) => {
    const dir = opts.dir || undefined;
    let results = await analyzeCaptures(dir);

    if (results.length === 0) {
      console.log(
        "No captures found. Start the proxy and make some API calls first.",
      );
      console.log("");
      console.log("Quick start:");
      console.log("  llm-inspector start");
      console.log("  export ANTHROPIC_BASE_URL=http://localhost:9000");
      console.log("  # ... use Claude Code or any Anthropic API client ...");
      console.log("  llm-inspector analyze");
      return;
    }

    // Sort
    if (opts.sort === "size") {
      results.sort((a, b) => b.totalBytes - a.totalBytes);
    } else if (opts.sort === "tokens") {
      results.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
    }
    // default (time): already sorted by filename timestamp

    // Limit to last N
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

// ── clean ──────────────────────────────────────────────────────────────────
program
  .command("clean")
  .description("Remove all captured request files")
  .option("--dir <path>", "Custom capture directory")
  .action(async (opts) => {
    const dir = opts.dir || undefined;
    const count = await cleanCaptures(dir);
    if (count === 0) {
      console.log("No captures to clean.");
    } else {
      console.log(`Removed ${count} capture file${count !== 1 ? "s" : ""}.`);
    }
  });

// ── status ─────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Check if proxy is running and show capture count")
  .action(async () => {
    const pidFile = getPidFile();
    let running = false;
    let pid: number | null = null;

    if (existsSync(pidFile)) {
      try {
        pid = parseInt(await readFile(pidFile, "utf-8"), 10);
        process.kill(pid, 0); // throws if not alive
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
        (f) => f.endsWith(".json") && !f.endsWith(".summary.json"),
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
              // skip
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
