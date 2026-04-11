# Claude Code Context Overhead — Diagnosis and On-Demand Solution

**Date:** 2026-04-10  
**Type:** Diagnosis + Solution  
**Beads:** bd-h5ye (design), bd-cx02 (MCP trim)  
**Related:** [context-compaction-optimization.md](../roadmap/context-compaction-optimization.md)

---

## tl;dr

Every Claude Code API call burns **~53K tokens of overhead** before any user content reaches the model. The single biggest lever: **built-in tool definitions** at 49% of overhead. The fix is a two-line shell alias using `--tools` that saves ~20K tokens/turn. For full on-demand capability, MCP proxy servers can be toggled mid-session.

---

## Problem

Context fills in ~3 turns without compaction. At ~53K tokens/turn on a 200K window:

```
Turn 0:  ~53K overhead → 147K remaining
Turn 1:  ~53K overhead →  94K remaining
Turn 2:  ~53K overhead →  41K remaining
Turn 3:  ~53K overhead →  context full, compaction fires
```

Claude Code's built-in tools (Agent, TeamCreate, TaskCreate, etc.) are injected into every API request regardless of whether they are used. The `Agent` tool alone costs **~4.6K tokens/turn** because it embeds all 33 custom agent definitions from `~/.claude/agents/` at runtime.

---

## Measurement

Captured via [llm-inspector](../README.md) capture proxy:

| Component | Bytes | ~Tokens | % |
|---|---|---|---|
| Built-in tool defs (31) | 91,932 | ~26,266 | 49% |
| - `Agent` tool alone | 18,481 | ~5,280 | 10% |
| MCP tool defs (26) | 27,694 | ~7,913 | 15% |
| System prompt | 28,113 | ~8,032 | 15% |
| CLAUDE.md stack (3 levels) | 30,010 | ~8,574 | 16% |
| Skills list | 7,164 | ~2,047 | 4% |
| **TOTAL** | **187,060** | **~53,446** | **100%** |

Measured on v2.1.98 with `claude --print "What is 2+2?"` (haiku model).

---

## Root Cause

Claude Code has two tool tiers with different mutability:

| Tier | Behavior | Cost |
|------|----------|------|
| **Built-in tools (`--tools` flag)** | Fixed at session start; cannot change mid-session | ~26K tokens/turn (all 31 tools) |
| **MCP tools** | Reactive — `mcp.tools` lives in zustand store; `toggleMcpServer()` updates live tool list immediately | ~8K tokens/turn (26 tools) |

The built-in tools are the problem. The `Agent` tool (4.6K tokens) is the single most expensive built-in tool. `TeamCreate` + `SendMessage` + `TeamDelete` together cost ~2.7K tokens. `TaskCreate/Update/Get/List/Output/Stop` cost ~2.8K tokens.

---

## Immediate Fix: `--tools` Flag (2-minute setup)

Start with a lean tool set, escape to full tools when needed.

```bash
# ~/.bashrc or ~/.zshrc
alias cl='claude --tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode,NotebookEdit"'
alias cl-full='claude'  # all tools when needed
```

**Token savings:**

| Profile | Built-in Tool Defs | MCP | Total Overhead |
|---------|--------------------|-----|----------------|
| Default (no flag) | ~26K tokens | ~8K | ~53K tokens/turn |
| Lean (`--tools` above) | ~6K tokens | ~8K | ~14K tokens/turn |
| **Savings** | **~20K tokens** | — | **~39K tokens/turn** |

That's a **73% reduction** in built-in tool overhead, or ~73% total reduction when MCP is also trimmed.

The lean profile still includes:
- Core coding: `Bash,Read,Write,Edit,Glob,Grep`
- Web: `WebFetch,WebSearch`
- Interactive: `AskUserQuestion,EnterPlanMode,ExitPlanMode,NotebookEdit`

It drops: `Agent,Skill,TeamCreate,TeamDelete,SendMessage,Task*`, `Cron*`, `EnterWorktree,ExitWorktree,RemoteTrigger`

---

## Full Solution: On-Demand MCP Proxies

For sessions that occasionally need agent spawning or team coordination, MCP proxy servers provide lightweight replacements for expensive built-in tools.

### Architecture

```
Session start (lean):
  --tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch"
  Heavy MCP proxies: DISABLED in settings (ao-agent-proxy, ao-team-proxy)
  Baseline: ~6K tokens built-in + ~0 MCP = ~6K overhead/turn

When agent spawning needed:
  User: /mcp → toggle "ao-agent-proxy" ON
  → ao-agent-proxy adds spawn_agent tool (~500 bytes vs Agent's 18.5KB)
  → Next turn has spawn_agent without Agent's 4.6K token cost

When team coordination needed:
  User: /mcp → toggle "ao-team-proxy" ON
  → Adds create_team, send_message, assign_task tools
```

### ao-agent-proxy (replaces `Agent` built-in)

```javascript
// ~/.config/mcp-daemon/proxies/ao-agent-proxy.js
{
  name: "spawn_agent",
  description: "Spawn an AO worker to handle a task.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      pr: { type: "number", description: "PR number (optional)" },
      bead: { type: "string", description: "Bead ID (optional)" }
    },
    required: ["task"]
  }
}
```

Tool description: **~500 bytes vs Agent's 18.5KB — 97% smaller**.

### Settings configuration

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "ao-agent-proxy": {
      "type": "http",
      "url": "http://127.0.0.1:8010/mcp",
      "disabled": true
    },
    "ao-team-proxy": {
      "type": "http",
      "url": "http://127.0.0.1:8011/mcp",
      "disabled": true
    }
  }
}
```

### MCP proxy implementation tracks

| Phase | Bead | Work |
|-------|------|------|
| 1 | bd-rk90 | Build ao-agent-proxy MCP server |
| 2 | bd-h5ye | Add to mcp-daemon start script as disabled-by-default |
| 3 | bd-cx02 | Combine: MCP trim + disable ao-team-proxy + ao-agent-proxy active |
| 4 | — | Shell alias `cl` for lean default; `cl-full` escape hatch |

---

## Per-Turn Context with Solutions

After applying lean `--tools` + disabling unused MCP servers:

| Component | Before | After (lean + MCP trim) |
|-----------|---------|-------------------------|
| Built-in tool defs | ~26K | ~6K |
| MCP tool defs | ~8K | ~0 (trim unused) |
| System prompt + CLAUDE.md | ~16K | ~16K (unchanged) |
| Skills list | ~2K | ~2K (unchanged) |
| **Total overhead** | **~53K** | **~24K** |

Context lifetime extends from **~3 turns to ~8 turns** before compaction fires. At typical 2-minute turns, that's ~16 minutes of session time vs ~6 minutes.

---

## Other Levers (if needed)

| Lever | Savings | Notes |
|-------|---------|-------|
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=1` | -2.9K from tool def | Relocates agent defs to system-reminder; total may increase |
| Trim `~/.claude/CLAUDE.md` | ~250 tokens/KB | Keep it lean |
| Reduce `~/.claude/agents/` count | ~100 tokens/agent | Each `.md` inflates `Agent` tool def |
| Trim MCP tool count | ~5-7K tokens/turn | Disable unused MCP servers in settings |
| Compact `MEMORY.md` | ~500 tokens | Skills listing injected every turn |

---

## Implementation Status

- [x] `--tools` flag confirmed working (v2.1.92+)
- [x] MCP `toggleMcpServer()` confirmed reactive mid-session (binary analysis + live test)
- [x] Shell alias pattern confirmed working
- [ ] ao-agent-proxy MCP server — not yet built
- [ ] ao-team-proxy MCP server — not yet built
- [ ] `CLAUDE_CODE_DEFAULT_TOOLS` env var — unconfirmed to exist

---

## Files

- `llm_inspector/docs/claude-code-context-growth-2025.md` — detailed benchmark data
- `llm_inspector/docs/on-demand-tool-profiles-solution.md` — this document
- `roadmap/on-demand-tool-profiles.md` — design doc with full architecture
- `roadmap/context-compaction-optimization.md` — compaction fix track
