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
import { readFile, unlink, readdir, writeFile } from "node:fs/promises";
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
import { scanSkillsUsage, formatSkillsUsage } from "./skills-usage.js";

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
      // Probe /openapi.json on port 8000 to confirm it's actually ccproxy,
      // not e.g. mem0_server (FastAPI), which also binds 8000. Just checking
      // `lsof -ti:8000` gives a false positive: any listener passes, so
      // ccproxy never gets auto-spawned when another service occupies 8000.
      //
      // ccproxy-api 0.2.x serves an OpenAPI document with title
      // "CCProxy API Server" at /openapi.json — that's the discriminator.
      const probeCcproxy = async (): Promise<boolean> => {
        try {
          const res = await fetch("http://127.0.0.1:8000/openapi.json", {
            signal: AbortSignal.timeout(1500),
          });
          if (!res.ok) return false;
          const body = (await res.json()) as { info?: { title?: string } };
          return body?.info?.title === "CCProxy API Server";
        } catch {
          return false;
        }
      };

      const ccproxyRunning = await probeCcproxy();

      if (!ccproxyRunning) {
        const ccproxyBin = process.env.CCPROXY_BIN || "ccproxy";
        try {
          const ccproxy = spawn(ccproxyBin, ["serve", "--port", "8000"], {
            detached: true,
            stdio: "ignore",
          });
          ccproxy.unref();
          // ccproxy takes ~3-12s to initialize plugins and bind (it sets up
          // OAuth/credential plugins before uvicorn.bind()). Wait, then re-probe.
          await new Promise((resolve) => setTimeout(resolve, 4000));
          if (await probeCcproxy()) {
            console.log("ccproxy started on port 8000 (OAuth → Anthropic).");
          } else {
            console.log(
              "ccproxy spawn returned but :8000/openapi.json does not yet answer as CCProxy — may still be initializing. Continuing anyway.",
            );
          }
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
    // Persist the PID so `stop` and `status` can find this detached worker.
    // Without this file, status reports STOPPED even when the proxy is alive.
    await writeFile(pidFile, String(child.pid));
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
  .option(
    "--skills-usage",
    "Report Claude Code skill/slash-command usage from session logs instead of capture analysis",
  )
  .option(
    "--days <n>",
    "Time window in days for --skills-usage (default: 30)",
    "30",
  )
  .option(
    "--projects-dir <path>",
    "Override ~/.claude/projects for --skills-usage (mainly for testing)",
  )
  .action(async (opts) => {
    if (opts.skillsUsage) {
      const days = opts.days ? parseInt(opts.days, 10) : undefined;
      const result = await scanSkillsUsage({
        projectsDir: opts.projectsDir,
        days,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSkillsUsage(result));
      }
      return;
    }

    const dir = opts.dir || undefined;
    const last = opts.last ? parseInt(opts.last, 10) : undefined;
    const sort = opts.sort || "time";
    let results = await analyzeCaptures(dir, { last, sort });

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

    // Fallback: if PID file is stale or missing (e.g. the worker was started
    // directly by launchd and never went through `cli start`, so no PID file
    // was written), check the port directly. This avoids the false STOPPED
    // report when port 9000 is actually answering requests.
    if (!running) {
      try {
        const portOwner = execSync("lsof -ti:9000 -sTCP:LISTEN", {
          stdio: "pipe",
        })
          .toString()
          .trim()
          .split("\n")[0];
        if (portOwner) {
          const parsed = parseInt(portOwner, 10);
          if (!Number.isNaN(parsed)) {
            pid = parsed;
            running = true;
          }
        }
      } catch {
        // nothing on 9000 either
      }
    }

    if (running) {
      console.log(`Proxy: RUNNING (PID ${pid})`);
    } else {
      console.log("Proxy: STOPPED");
    }

    // ── Show ccproxy status (port 8000) ──────────────────────────────────
    // The capture chain requires ccproxy-api on :8000 to be running.
    // llm-inspector start auto-launches ccproxy if needed, but report
    // its state here so users can see whether the chain is complete.
    //
    // Probe /openapi.json title to distinguish ccproxy-api from other
    // services that may occupy 8000 (e.g. mem0_server). Without this,
    // `status` reports RUNNING when only mem0 is listening — false positive
    // that misleads users into thinking the capture chain is healthy.
    const probeCcproxy = async (): Promise<boolean> => {
      try {
        const res = await fetch("http://127.0.0.1:8000/openapi.json", {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { info?: { title?: string } };
        return body?.info?.title === "CCProxy API Server";
      } catch {
        return false;
      }
    };

    const ccproxyRunning = await probeCcproxy();
    if (ccproxyRunning) {
      console.log("ccproxy: RUNNING (port 8000)");
    } else {
      // Distinguish "nothing on 8000" from "something else on 8000"
      let somethingElseOn8000 = false;
      try {
        execSync("lsof -ti:8000", { stdio: "pipe" });
        somethingElseOn8000 = true;
      } catch {
        somethingElseOn8000 = false;
      }
      if (somethingElseOn8000) {
        console.log(
          "ccproxy: NOT DETECTED on :8000 (a different service is listening there) — start with: llm-inspector start",
        );
      } else {
        console.log("ccproxy: STOPPED (port 8000) — start with: llm-inspector start");
      }
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
