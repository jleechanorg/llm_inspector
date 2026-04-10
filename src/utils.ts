/**
 * Utility helpers for token estimation, formatting, and file management.
 */

import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { CapturedRequest, ContentBlock, Message } from "./types.js";

// Convenience constants re-exported for consumers that import by name
export const DEFAULT_CAPTURE_DIR = resolve(homedir(), ".llm-inspector", "captures");
export const PID_FILE = resolve(homedir(), ".llm-inspector", "llm-inspector.pid");

/**
 * Returns ~/.llm-inspector/
 */
export function getConfigDir(): string {
  return resolve(homedir(), ".llm-inspector");
}

/**
 * Returns ~/.llm-inspector/captures/ (creates if needed).
 */
export function getCaptureDir(): string {
  const dir = join(getConfigDir(), "captures");
  if (!existsSync(dir)) {
    // Sync create for simplicity — called once at startup
    import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  }
  return dir;
}

/**
 * Ensure capture dir exists (async version).
 */
export async function ensureCaptureDir(): Promise<string> {
  const dir = join(getConfigDir(), "captures");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the PID file path.
 */
export function getPidFile(): string {
  return join(getConfigDir(), "proxy.pid");
}

/** Default proxy port. */
export const DEFAULT_PORT = 9000;

/**
 * Rough token estimation: ~3.5 characters per token for JSON/mixed content.
 * Accepts a string or an object (which gets JSON-serialized).
 */
export function estimateTokens(input: string | object): number {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate tokens for a content block array (Anthropic format).
 */
export function estimateContentBlockTokens(blocks: ContentBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.text) {
      total += estimateTokens(block.text);
    }
    if (block.input) {
      total += estimateTokens(JSON.stringify(block.input));
    }
    if (typeof block.content === "string") {
      total += estimateTokens(block.content);
    } else if (Array.isArray(block.content)) {
      total += estimateContentBlockTokens(block.content);
    }
  }
  return total;
}

/**
 * Estimate tokens for a single message.
 */
export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content);
  }
  if (Array.isArray(message.content)) {
    return estimateContentBlockTokens(message.content);
  }
  return 0;
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a number with commas for display.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatPercent(n: number): string {
  return n < 1 && n > 0 ? "<1%" : `${Math.round(n)}%`;
}

/**
 * Simple ASCII table formatter.
 * First row is treated as header.
 */
export function formatTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  // Compute column widths
  const colWidths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, row[i].length);
    }
  }

  const sep = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const lines: string[] = [];

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((cell, i) => cell.padEnd(colWidths[i]));
    lines.push("| " + cells.join(" | ") + " |");
    if (r === 0) {
      lines.push(sep);
    }
  }

  return lines.join("\n");
}

/**
 * Load all captured request files from the capture directory.
 */
export async function loadCapturedRequests(
  dir?: string,
): Promise<CapturedRequest[]> {
  const captureDir = dir || (await ensureCaptureDir());
  if (!existsSync(captureDir)) {
    return [];
  }

  const files = await readdir(captureDir);
  const jsonFiles = files
    .filter((f) => f.endsWith(".json") && !f.endsWith(".summary.json"))
    .sort();
  const requests: CapturedRequest[] = [];

  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(captureDir, file), "utf-8");
      const parsed = JSON.parse(content) as CapturedRequest;
      parsed.filePath = join(captureDir, file);
      requests.push(parsed);
    } catch {
      // Skip malformed files
    }
  }

  return requests;
}

/**
 * Clean all captured request files from the capture directory.
 */
export async function cleanCaptures(dir?: string): Promise<number> {
  const captureDir = dir || (await ensureCaptureDir());
  if (!existsSync(captureDir)) {
    return 0;
  }

  const files = await readdir(captureDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  for (const file of jsonFiles) {
    await rm(join(captureDir, file));
  }

  return jsonFiles.length;
}

/**
 * Save a captured request to disk.
 */
export async function saveCapturedRequest(
  request: CapturedRequest,
  dir?: string,
): Promise<string> {
  const captureDir = dir || (await ensureCaptureDir());
  const filename = `${request.timestamp.replace(/[:.]/g, "-")}-${Date.now()}.json`;
  const filepath = join(captureDir, filename);
  await writeFile(filepath, JSON.stringify(request, null, 2));
  return filepath;
}

/**
 * Redact sensitive header values (Authorization, API keys).
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  const sensitiveKeys = ["authorization", "x-api-key", "api-key"];

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      redacted[key] = value.slice(0, 10) + "..." + value.slice(-4);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}
