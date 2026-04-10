/**
 * Analyzer: breaks down captured LLM API requests into component-level
 * byte and token usage with MCP vs built-in tool splitting.
 */

import type {
  CapturedRequest,
  AnalysisResult,
  ComponentBreakdown,
  ComponentDetail,
} from "./types.js";
import {
  estimateTokens,
  formatBytes,
  formatNumber,
  formatTable,
  loadCapturedRequests,
} from "./utils.js";

/**
 * Analyze a single captured request into a component breakdown.
 */
export function analyzeRequest(captured: CapturedRequest): AnalysisResult {
  const body = captured.body;
  const breakdown: ComponentBreakdown[] = [];
  let totalBytes = 0;
  let userMessageBytes = 0;

  // ── 1. System prompt ──────────────────────────────────────────────────
  if (body.system) {
    const sysStr =
      typeof body.system === "string"
        ? body.system
        : JSON.stringify(body.system);
    const fullBytes = Buffer.byteLength(sysStr, "utf-8");
    totalBytes += fullBytes;

    // Try to detect CLAUDE.md / instructions and skills within the system prompt
    const claudeMdRegex =
      /Contents of [^\n]*CLAUDE\.md[\s\S]*?(?=Contents of [^\n]*CLAUDE\.md|<system-reminder>|$)/g;
    const skillsRegex =
      /The following skills are available[\s\S]*?(?=<\/system-reminder>|$)/;
    const systemReminderRegex = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

    let instructionBytes = 0;
    let skillsBytes = 0;

    // Find all CLAUDE.md sections
    const claudeMatches = sysStr.match(claudeMdRegex);
    if (claudeMatches) {
      for (const match of claudeMatches) {
        instructionBytes += Buffer.byteLength(match, "utf-8");
      }
    }

    // Find skills listing
    const skillsMatch = sysStr.match(skillsRegex);
    if (skillsMatch) {
      skillsBytes = Buffer.byteLength(skillsMatch[0], "utf-8");
    }

    // Avoid double-counting: system-reminder blocks may contain both
    // CLAUDE.md content and skills. If we found them inside system-reminder,
    // the base system prompt is the remainder.
    const systemReminderMatches = sysStr.match(systemReminderRegex);
    let systemReminderTotalBytes = 0;
    if (systemReminderMatches) {
      for (const m of systemReminderMatches) {
        systemReminderTotalBytes += Buffer.byteLength(m, "utf-8");
      }
    }

    // If we found sub-sections, split; otherwise report as one block
    if (instructionBytes > 0 || skillsBytes > 0) {
      const baseBytes = fullBytes - instructionBytes - skillsBytes;

      if (baseBytes > 0) {
        breakdown.push({
          component: "System prompt",
          bytes: baseBytes,
          tokens: Math.ceil(baseBytes / 3.5),
          percentage: 0,
        });
      }

      if (instructionBytes > 0) {
        breakdown.push({
          component: "CLAUDE.md / instructions",
          bytes: instructionBytes,
          tokens: Math.ceil(instructionBytes / 3.5),
          percentage: 0,
        });
      }

      if (skillsBytes > 0) {
        breakdown.push({
          component: "Skills list",
          bytes: skillsBytes,
          tokens: Math.ceil(skillsBytes / 3.5),
          percentage: 0,
        });
      }
    } else {
      breakdown.push({
        component: "System prompt",
        bytes: fullBytes,
        tokens: estimateTokens(sysStr),
        percentage: 0,
      });
    }
  }

  // ── 2. Tool definitions ───────────────────────────────────────────────
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const builtinTools: ComponentDetail[] = [];
    const mcpServers = new Map<string, ComponentDetail[]>();
    let builtinTotalBytes = 0;
    let mcpTotalBytes = 0;

    for (const tool of body.tools) {
      const toolStr = JSON.stringify(tool);
      const toolBytes = Buffer.byteLength(toolStr, "utf-8");
      const toolName = tool.name || tool.function?.name || "unnamed";

      if (toolName.startsWith("mcp__")) {
        // MCP tool: group by server name (mcp__<server>__<method>)
        const parts = toolName.split("__");
        const serverName = parts.length >= 2 ? parts[1] : "unknown";

        if (!mcpServers.has(serverName)) {
          mcpServers.set(serverName, []);
        }
        mcpServers.get(serverName)!.push({
          name: toolName,
          bytes: toolBytes,
          tokens: estimateTokens(toolStr),
        });
        mcpTotalBytes += toolBytes;
      } else {
        builtinTools.push({
          name: toolName,
          bytes: toolBytes,
          tokens: estimateTokens(toolStr),
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
        details: builtinTools,
      });
    }

    if (mcpServers.size > 0) {
      // Aggregate MCP tools by server
      const mcpDetails: ComponentDetail[] = [];
      for (const [server, tools] of mcpServers) {
        const serverBytes = tools.reduce((s, t) => s + t.bytes, 0);
        const serverTokens = tools.reduce((s, t) => s + t.tokens, 0);
        mcpDetails.push({
          name: `${server} (${tools.length})`,
          bytes: serverBytes,
          tokens: serverTokens,
        });
      }
      mcpDetails.sort((a, b) => b.bytes - a.bytes);

      const totalMcpToolCount = Array.from(mcpServers.values()).reduce(
        (s, arr) => s + arr.length,
        0,
      );
      totalBytes += mcpTotalBytes;
      breakdown.push({
        component: `MCP tool defs (${totalMcpToolCount})`,
        bytes: mcpTotalBytes,
        tokens: mcpDetails.reduce((s, d) => s + d.tokens, 0),
        percentage: 0,
        details: mcpDetails,
      });
    }
  }

  // ── 3. Messages ───────────────────────────────────────────────────────
  if (body.messages && Array.isArray(body.messages)) {
    let systemReminderBytes = 0;
    let userBytes = 0;
    let assistantBytes = 0;
    let toolResultBytes = 0;

    for (const msg of body.messages) {
      const contentStr =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      const msgBytes = Buffer.byteLength(contentStr, "utf-8");

      // Detect system-reminder injections in user messages
      let isSystemReminder = false;
      if (typeof msg.content === "string") {
        if (msg.content.includes("<system-reminder>")) {
          isSystemReminder = true;
        }
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === "text" &&
            block.text?.includes("<system-reminder>")
          ) {
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
        // system role in messages, etc.
        userBytes += msgBytes;
      }
    }

    if (systemReminderBytes > 0) {
      totalBytes += systemReminderBytes;
      breakdown.push({
        component: "System reminders (in messages)",
        bytes: systemReminderBytes,
        tokens: Math.ceil(systemReminderBytes / 3.5),
        percentage: 0,
      });
    }

    if (userBytes > 0) {
      totalBytes += userBytes;
      breakdown.push({
        component: "User messages",
        bytes: userBytes,
        tokens: Math.ceil(userBytes / 3.5),
        percentage: 0,
      });
    }

    if (assistantBytes > 0) {
      totalBytes += assistantBytes;
      breakdown.push({
        component: "Assistant messages",
        bytes: assistantBytes,
        tokens: Math.ceil(assistantBytes / 3.5),
        percentage: 0,
      });
    }

    if (toolResultBytes > 0) {
      totalBytes += toolResultBytes;
      breakdown.push({
        component: "Tool results",
        bytes: toolResultBytes,
        tokens: Math.ceil(toolResultBytes / 3.5),
        percentage: 0,
      });
    }
  }

  // If nothing parsed from structure, fall back to total body size
  if (totalBytes === 0 && captured.bodySize > 0) {
    totalBytes = captured.bodySize;
    breakdown.push({
      component: "Request body (unstructured)",
      bytes: totalBytes,
      tokens: Math.ceil(totalBytes / 3.5),
      percentage: 100,
    });
  }

  // Compute percentages and total estimated tokens
  const estimatedTokens = breakdown.reduce((s, b) => s + b.tokens, 0);
  for (const b of breakdown) {
    b.percentage =
      totalBytes > 0 ? Math.round((b.bytes / totalBytes) * 100) : 0;
  }

  return {
    totalBytes,
    estimatedTokens,
    breakdown,
    model: body.model,
    userMessageBytes,
  };
}

/**
 * Analyze all captures in a directory.
 */
export async function analyzeCaptures(dir?: string): Promise<AnalysisResult[]> {
  const requests = await loadCapturedRequests(dir);
  return requests.map(analyzeRequest);
}

/**
 * Format analysis results as a human-readable report.
 */
export function formatAnalysis(results: AnalysisResult[]): string {
  if (results.length === 0) {
    return "No captures found. Start the proxy and make some API calls first.";
  }

  const lines: string[] = [];
  lines.push("=== LLM Inspector Analysis ===");
  lines.push(
    `Captured ${results.length} request${results.length > 1 ? "s" : ""}`,
  );
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const model = result.model || "unknown";
    const tokensStr =
      result.estimatedTokens >= 1000
        ? `~${Math.round(result.estimatedTokens / 1000)}K`
        : `~${result.estimatedTokens}`;

    lines.push(
      `Request ${i + 1}: ${model} (${formatNumber(result.totalBytes)} bytes, ${tokensStr} tokens)`,
    );

    // Build table rows
    const rows: string[][] = [["Component", "Bytes", "~Tokens", "%"]];

    for (const comp of result.breakdown) {
      const pctStr = comp.percentage < 1 ? "<1%" : `${comp.percentage}%`;
      rows.push([
        comp.component,
        formatNumber(comp.bytes),
        formatNumber(comp.tokens),
        pctStr,
      ]);

      // Show top sub-component details
      if (comp.details) {
        const topDetails = comp.details.slice(0, 5);
        for (const detail of topDetails) {
          const detailPct =
            result.totalBytes > 0
              ? Math.round((detail.bytes / result.totalBytes) * 100)
              : 0;
          const detailPctStr = detailPct < 1 ? "<1%" : `${detailPct}%`;
          rows.push([
            `  ${detail.name}`,
            formatNumber(detail.bytes),
            formatNumber(detail.tokens),
            detailPctStr,
          ]);
        }
        if (comp.details.length > 5) {
          rows.push([
            `  ... and ${comp.details.length - 5} more`,
            "",
            "",
            "",
          ]);
        }
      }
    }

    // TOTAL row
    rows.push([
      "TOTAL",
      formatNumber(result.totalBytes),
      formatNumber(result.estimatedTokens),
      "100%",
    ]);

    lines.push(formatTable(rows));
    lines.push("");
  }

  return lines.join("\n");
}
