# Claude Code Built-in Tool Token Cost by Version

**Date:** 2026-04-10  
**Type:** Benchmark data  
**Method:** `llm-inspector` capture proxy → `ccproxy` (OAuth) → Anthropic API  
**Source:** `llm_inspector/docs/claude-code-context-growth-2025.md`

---

## Version Summary

| Version | Date | Total Request | Built-in Tools | Tool Defs | Tool Defs Tokens | Delta |
|---------|------|-------------|----------------|----------|-----------------|-------|
| 2.1.30 | Feb 3 | 124.6 KB (~31K) | 23 | 55.9 KB | ~14K | baseline |
| 2.1.40 | Feb 12 | 143.0 KB (~36K) | 26 | 68.2 KB | ~17K | +3 tools, +3K tokens |
| 2.1.50 | Feb 20 | 146.8 KB (~37K) | 27 | 70.5 KB | ~18K | +1 tool |
| 2.1.61 | Feb 26 | 147.0 KB (~37K) | 27 | 70.8 KB | ~18K | — |
| **2.1.70** | Mar 6 | **228.7 KB (~57K)** | **118** | **94.6 KB** | **~24K** | **MCP bug: +91 tools** |
| 2.1.77 | Mar 16 | 236.0 KB (~59K) | 122 | 98.6 KB | ~25K | +4 more |
| 2.1.84 | Mar 25 | 231.0 KB (~58K) | 123 | 90.5 KB | ~23K | peak MCP count |
| **2.1.92** | Apr 4 | **180.8 KB (~45K)** | **57** | **80.4 KB** | **~20K** | **MCP bug fixed** |
| 2.1.98 | Apr 9 | 183.8 KB (~46K) | 58 | 83.1 KB | ~21K | current |

> Token estimates use `bytes / 4` for JSON/code payloads. MCP tools excluded from built-in counts above.

---

## Key Inflection Points

### v2.1.70 (Mar 6) — MCP injection bug
**Before:** 27 built-in tools, ~14K tokens tool defs  
**After:** 27 built-in + 91 MCP tools injected into print mode  
**Impact:** Total request +84% (124.6 KB → 228.7 KB)  
**Root cause:** MCP server tool definitions were being injected into `-p`/print mode even without an active MCP session

### v2.1.92 (Apr 4) — Bug fixed
MCP tools removed from print mode  
**Impact:** Total request -24% from peak (231 KB → 180.8 KB)  
**Note:** `--tools` flag also introduced in this release

### v2.1.98 (Apr 9) — Current
58 built-in tools, ~21K tokens for built-in tool defs  
Total overhead (interactive session): ~53K tokens/turn

---

## Built-in Tool Breakdown (v2.1.98)

All 58 built-in tools, sorted by token cost:

| Tool(s) | Bytes | ~Tokens | % Built-in | Category |
|---------|-------|---------|-----------|----------|
| **Agent** | 18,481 | ~4,640 | 17.7% | Agentic |
| **Bash** | 11,737 | ~2,934 | 11.2% | Shell |
| TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop | 11,310 | ~2,828 | 10.8% | Tasks |
| AskUserQuestion, EnterPlanMode, ExitPlanMode, NotebookEdit | 13,530 | ~3,383 | 12.9% | Interactive |
| Read, Write, Edit, Glob, Grep | 9,670 | ~2,418 | 9.2% | File I/O |
| EnterWorktree, ExitWorktree | 4,400 | ~1,100 | 4.2% | Worktree |
| CronCreate, CronDelete, CronList | 4,100 | ~1,025 | 3.9% | Scheduling |
| WebFetch, WebSearch | 3,800 | ~950 | 3.6% | Web |
| TeamCreate, TeamDelete, SendMessage | 11,000 | ~2,750 | 10.5% | Teams |
| Skill | 1,720 | ~430 | 1.6% | Agentic |
| RemoteTrigger | 1,000 | ~250 | 1.0% | Misc |
| **Total** | **91,932** | **~26,266** | **100%** | |

> `Agent` alone is 17.7% of built-in tool overhead — it embeds all `~/.claude/agents/` definitions at runtime.

---

## Tool Cost Tiers

### Tier 1: Expensive (1K+ tokens each)
| Tool | ~Tokens | Notes |
|------|---------|-------|
| Agent | 4,640 | Embeds all custom agent definitions |
| Bash | 2,934 | Extensive permission/usage docs |
| TaskCreate + 5 others | 2,828 | 6 tools |
| TeamCreate + 2 others | 2,750 | 3 tools |
| EnterPlanMode + 3 others | 3,383 | 4 tools |

### Tier 2: Medium (300-800 tokens each)
| Tool | ~Tokens | Notes |
|------|---------|-------|
| EnterWorktree, ExitWorktree | 1,100 | 2 tools |
| CronCreate + 2 others | 1,025 | 3 tools |
| WebFetch, WebSearch | 950 | 2 tools |
| Skill | 430 | Slash command invoker |

### Tier 3: Light (<300 tokens)
| Tool | ~Tokens | Notes |
|------|---------|-------|
| RemoteTrigger | 250 | API trigger |
| (other file I/O tools) | ~2,418 | Read, Write, Edit, Glob, Grep |

---

## `--tools` Flag Measured Impact (v2.1.98)

| Profile | `--tools` value | Tool Defs Size | Tool Defs Tokens | Total Request |
|---------|----------------|---------------|-----------------|---------------|
| **Default** | *(none)* | 116.9 KB | ~29K tokens | ~205 KB (~52K tokens) |
| **Lean** | `"Bash,Read,Edit"` | 15.6 KB | ~3.9K tokens | 20.1 KB (~5K tokens) |
| **Savings** | | -101.3 KB | -25K tokens | -184.7 KB |

Lean profile (3 tools): **90% reduction** in built-in tool overhead.

---

## Why Do Built-in Tools Grow?

Each Claude Code release adds:
1. New built-in tools (e.g., `EnterWorktree` added ~v2.1.50)
2. Expanded descriptions for existing tools (more permission flags, usage examples)
3. New agent type definitions in the runtime catalog

The `Agent` tool is the worst offender: it contains a runtime template that injects all `~/.claude/agents/` definitions. Every custom agent `.md` file you have adds ~100 tokens to the `Agent` tool definition.

---

## Practical Implications

1. **Every custom agent definition costs ~100 tokens/turn** — kept in `Agent` tool def
2. **The `--tools` flag is the only user-controlled lever** for built-in tool overhead
3. **MCP tools are reactive mid-session** — toggle them off by default, enable on demand
4. **v2.1.92+ is the minimum version** for `--tools` flag to work

---

## Files

- `llm_inspector/docs/claude-code-context-growth-2025.md` — full benchmark with system prompt, MCP, CLAUDE.md breakdown
- `llm_inspector/docs/on-demand-tool-profiles-solution.md` — solution doc
- `roadmap/on-demand-tool-profiles.md` — design doc with MCP proxy architecture
