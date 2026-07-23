#!/usr/bin/env node
/**
 * End-to-End Codex E2E Test for llm-inspector.
 *
 * Validates that the capture proxy transparently forwards Codex CLI's
 * OpenAI-format HTTP traffic to an arbitrary `--upstream` URL, capturing
 * full request/response bytes to disk.
 *
 * Sandboxed: uses CODEX_HOME=/tmp/codex-test-e2e so ~/.codex/ is untouched.
 * Uses OPENAI_API_KEY env var (no codex login required) and a mock upstream
 * that always returns 401, so the test never hits a real provider.
 *
 * Uses startProxy() directly (not the CLI) to avoid the shared PID file at
 * ~/.llm-inspector/proxy.pid — running alongside other proxies on the host
 * would otherwise cause the CLI to refuse to start.
 *
 * Usage:
 *   node scripts/test-codex-e2e.mjs
 *
 * Exit 0 on success, non-zero on failure.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../");

// tsup emits the proxy module as dist/proxy-<hash>.js with a content hash
// in the filename, so we discover it at runtime rather than hard-coding.
const proxyChunk = readdirSync(resolve(REPO_ROOT, "dist")).find(
  (f) => /^proxy-.*\.js$/.test(f),
);
if (!proxyChunk) {
  console.error(
    "✗ Could not find dist/proxy-*.js — run `npm run build` first.",
  );
  process.exit(1);
}
const { startProxy } = await import(
  pathToFileURL(resolve(REPO_ROOT, "dist", proxyChunk)).href
);

const PROXY_PORT = 19000;
const MOCK_UPSTREAM_PORT = 19001;

const SANDBOX_HOME = "/tmp/codex-test-e2e";
const SANDBOX_AUTH = join(SANDBOX_HOME, "auth.json");
const CAPTURE_DIR = join(SANDBOX_HOME, "captures");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg) {
  console.log(`\n→ ${msg}`);
}

function fatal(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function cleanSandbox() {
  if (existsSync(SANDBOX_HOME)) {
    rmSync(SANDBOX_HOME, { recursive: true, force: true });
  }
}

function setupSandbox() {
  cleanSandbox();
  mkdirSync(SANDBOX_HOME, { recursive: true });
  // codex needs auth.json to exist (even empty) under CODEX_HOME so it doesn't
  // try to fall back to ~/.codex/auth.json. OPENAI_API_KEY env var provides
  // the actual credentials.
  writeFileSync(
    SANDBOX_AUTH,
    JSON.stringify({ OPENAI_API_KEY: "sk-test-fake-not-real" }, null, 2),
  );
  // codex does NOT honor OPENAI_BASE_URL by itself for OpenAI requests; the
  // provider base URL must be configured in config.toml. Pin the openai
  // provider to our proxy so codex never reaches api.openai.com.
  writeFileSync(
    join(SANDBOX_HOME, "config.toml"),
    [
      `model_provider = "openai-custom"`,
      `model = "gpt-5-mini"`,
      ``,
      `[model_providers.openai-custom]`,
      `name = "OpenAI (proxy)"`,
      `base_url = "http://127.0.0.1:${PROXY_PORT}/v1"`,
      `wire_api = "responses"`,
      ``,
      `[sandbox]`,
      `mode = "danger-full-access"`,
      ``,
    ].join("\n"),
  );
  if (!existsSync(CAPTURE_DIR)) {
    mkdirSync(CAPTURE_DIR, { recursive: true });
  }
}

async function startMockUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      console.log(`  mock-upstream ← ${req.method} ${req.url} (${body.length}B)`);
      // Always return 401 so codex gets a clean rejection — we're only
      // verifying the proxy captures the REQUEST, not the upstream behavior.
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "fake key for e2e test",
            type: "invalid_request_error",
          },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(MOCK_UPSTREAM_PORT, "127.0.0.1", r));
  console.log(`  mock-upstream listening on :${MOCK_UPSTREAM_PORT}`);
  return { server, hits };
}

async function startProxyServer() {
  // Pin the capture dir to the sandbox BEFORE calling startProxy; the proxy
  // reads LLM_INSPECTOR_CAPTURE_DIR at startup.
  process.env.LLM_INSPECTOR_CAPTURE_DIR = CAPTURE_DIR;
  // Use the programmatic API directly so we don't share the global
  // ~/.llm-inspector/proxy.pid with the user's other proxy instances.
  const server = await startProxy({
    port: PROXY_PORT,
    upstream: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
    verbose: false,
    toolMode: "observe",
    timeoutMs: 10_000,
  });
  // Poll until the port is actually accepting connections
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/`, {
        signal: AbortSignal.timeout(200),
      });
      if (r) return server;
    } catch {
      // still starting
    }
  }
  fatal("Proxy did not start within 5s");
}

async function runCodex() {
  step("Running sandboxed codex (CODEX_HOME=" + SANDBOX_HOME + ")");
  const child = spawn(
    "codex",
    ["--yolo", "exec", "ping"],
    {
      env: {
        ...process.env,
        CODEX_HOME: SANDBOX_HOME,
        OPENAI_API_KEY: "sk-test-fake-not-real",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    process.stdout.write(`  codex: ${s}`);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    process.stderr.write(`  codex-err: ${s}`);
  });

  // codex might exit quickly on 401, or hang trying. 30s timeout.
  const exitCode = await Promise.race([
    new Promise((r) => child.on("close", r)),
    sleep(30000).then(() => {
      child.kill("SIGKILL");
      return "TIMEOUT";
    }),
  ]);
  return { exitCode, stdout, stderr };
}

async function findCaptures(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(CAPTURE_DIR)) {
      await sleep(100);
      continue;
    }
    const files = readdirSync(CAPTURE_DIR).filter(
      (f) => f.startsWith("capture-") && !f.endsWith(".summary.json"),
    );
    const nonEmpty = files.filter(
      (f) =>
        existsSync(join(CAPTURE_DIR, f)) &&
        readFileSync(join(CAPTURE_DIR, f), "utf-8").length > 0,
    );
    if (nonEmpty.length >= 1) return nonEmpty;
    await sleep(100);
  }
  return [];
}

async function main() {
  console.log("=== llm-inspector Codex E2E test ===\n");

  step("Setting up sandbox at " + SANDBOX_HOME);
  setupSandbox();

  step("Starting mock OpenAI upstream");
  const { server: mock } = await startMockUpstream();

  let proxyServer;
  try {
    step("Starting capture proxy on :" + PROXY_PORT);
    proxyServer = await startProxyServer();

    step("Invoking sandboxed codex");
    const { exitCode, stderr } = await runCodex();
    console.log(`  codex exited with code: ${exitCode}`);

    step("Verifying capture directory");
    const files = await findCaptures();
    if (files.length === 0) {
      console.error("  codex stderr (last 500 chars):", stderr.slice(-500));
      fatal("No capture files found in " + CAPTURE_DIR);
    }
    console.log(`  ✓ Found ${files.length} capture file(s)`);

    step("Inspecting latest capture");
    const latest = files[files.length - 1];
    const captured = JSON.parse(
      readFileSync(join(CAPTURE_DIR, latest), "utf-8"),
    );

    const checks = [
      ["method", captured.method === "POST"],
      ["path is OpenAI-format (/v1/...)", /^\/v1\//.test(captured.path)],
      ["path does NOT have /claude prefix", !captured.path.startsWith("/claude/")],
      ["body parsed (model set)", typeof captured.body?.model === "string"],
      ["authorization header redacted on disk", captured.headers?.authorization?.includes("...") || captured.headers?.authorization === "[REDACTED]"],
      ["bodySize > 0", captured.bodySize > 0],
      ["request_raw present", typeof captured.request_raw === "string"],
    ];

    let allPass = true;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${name}`);
      if (!ok) allPass = false;
    }

    if (!allPass) {
      console.log("\n  Captured object:", JSON.stringify(captured, null, 2));
      fatal("One or more capture assertions failed");
    }

    console.log("\n=== E2E PASSED ===");
    console.log(`  Capture: ${CAPTURE_DIR}/${latest}`);
    console.log(`  Path:    ${captured.path}`);
    console.log(`  Model:   ${captured.body?.model}`);
    console.log(`  Bytes:   ${captured.bodySize}`);
  } finally {
    if (proxyServer) {
      await new Promise((r) => proxyServer.close(() => r()));
    }
    mock.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});