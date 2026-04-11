# Claude Code Context Growth Analysis (Feb–Apr 2025)

**Generated:** 2025-04-11  
**Method:** llm-inspector capture proxy — version benchmark (9 releases) + live `--tools` flag test  
**Prompt:** `claude -p --dangerously-skip-permissions "What is 2+2?"` (minimal baseline)

## Summary

Claude Code request size grew **+47%** (124.6 KB → 183.8 KB, ~31K → ~46K tokens) from v2.1.30 to v2.1.98.
A temporary bug in v2.1.70 injected MCP tool definitions into `-p` mode, briefly spiking requests to
**228.7 KB (~57K tokens)** before being fixed in v2.1.92.

Organic growth from built-in tool expansion accounts for ~15K tokens (+50%) of the permanent baseline increase.

The `--tools` flag (available since v2.1.92+) can reduce built-in tool overhead by up to **73%** (~22K → ~6K tokens)
with a lean profile, or **~90% total request reduction** when combined with no MCP.

---

## Version Benchmark

| Version | Date | Total Request | # Built-in Tools | Tool Defs Size |
|---------|------|--------------|-----------------|----------------|
| 2.1.30 | Feb 3 | 124.6 KB (~31K tokens) | 23 | 55.9 KB (~14K tokens) |
| 2.1.40 | Feb 12 | 143.0 KB (~36K tokens) | 26 | 68.2 KB (~17K tokens) |
| 2.1.50 | Feb 20 | 146.8 KB (~37K tokens) | 27 | 70.5 KB (~18K tokens) |
| 2.1.61 | Feb 26 | 147.0 KB (~37K tokens) | 27 | 70.8 KB (~18K tokens) |
| **2.1.70** | Mar 6 | **228.7 KB (~57K tokens)** ⚠️ | **118** | 94.6 KB (~24K tokens) |
| 2.1.77 | Mar 16 | 236.0 KB (~59K tokens) ⚠️ | 122 | 98.6 KB (~25K tokens) |
| 2.1.84 | Mar 25 | 231.0 KB (~58K tokens) ⚠️ | 123 | 90.5 KB (~23K tokens) |
| **2.1.92** | Apr 4 | **180.8 KB (~45K tokens)** ✅ | **57** | 80.4 KB (~20K tokens) |
| 2.1.98 | Apr 9 | 183.8 KB (~46K tokens) | 58 | 83.1 KB (~21K tokens) |

> Token estimates: ~4 chars/token for JSON/code payloads.

---

## Inflection Points

### v2.1.70 (Mar 6) — MCP injection bug (+84% request size)
Tool count jumped 27 → 118. MCP server tool definitions were being injected into `-p`/print mode
even without an active MCP session. Persisted through v2.1.84 (123 tools at peak).

### v2.1.92 (Apr 4) — Bug fixed (-24% from peak)
Tool count dropped 123 → 57. MCP tools no longer injected in print mode.
Request size fell from 231 KB to 180.8 KB (~57K → ~45K tokens).

---

## Per-Turn Context Breakdown (v2.1.98, live interactive session)

Measured via llm-inspector capture of a real interactive Claude Code session:

| Component | Bytes | ~Tokens | % of total |
|-----------|-------|---------|-----------|
| Built-in tool definitions | 116.9 KB | ~29K | ~57% |
| System prompt + CLAUDE.md | 27.4 KB | ~7K | ~13% |
| MCP tool definitions | ~29.0 KB | ~7K | ~14% |
| Messages + overhead | ~32.5 KB | ~8K | ~16% |
| **Total (full session)** | **~205 KB** | **~52K** | 100% |

> The `Agent` tool alone is **18.5 KB (~4.6K tokens)** — it embeds descriptions of all custom agents
> from `~/.claude/agents/` at runtime, making it the single most expensive built-in tool.

---

## Built-in Tool Breakdown by Category

All 27 built-in tools (v2.1.98), sorted by token cost:

| Category | Tools | Total Bytes | ~Tokens | Notes |
|----------|-------|-------------|---------|-------|
| Agentic | Agent, Skill | 20.2 KB | ~5K | `Agent` embeds all `~/.claude/agents/` defs |
| Shell | Bash | 11.7 KB | ~2.9K | Extensive permission/usage docs |
| Teams | TeamCreate, TeamDelete, SendMessage | 11.0 KB | ~2.7K | Multi-agent coordination |
| Tasks | TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop | 11.3 KB | ~2.8K | Session task tracking |
| Interactive | AskUserQuestion, EnterPlanMode, ExitPlanMode, NotebookEdit | 13.5 KB | ~3.4K | Plan mode, Jupyter |
| File I/O | Read, Write, Edit, Glob, Grep | 9.7 KB | ~2.4K | Core coding tools |
| Worktree | EnterWorktree, ExitWorktree | 4.4 KB | ~1.1K | Git worktree isolation |
| Scheduling | CronCreate, CronDelete, CronList | 4.1 KB | ~1K | Recurring tasks |
| Web | WebFetch, WebSearch | 3.8 KB | ~950 | External lookups |
| Misc | RemoteTrigger | 1.0 KB | ~250 | Remote trigger API |
| **Total** | **27 tools** | **90.7 KB** | **~22K** | |

---

## `--tools` Flag: Measured Savings (Live Capture)

Tested on v2.1.98 via llm-inspector. Same session, same prompt:

| Profile | `--tools` value | File Size | Tool Defs | System | Total |
|---------|----------------|-----------|-----------|--------|-------|
| **Default** | *(omit flag)* | 204.8 KB | 116.9 KB (~29K tokens) | 27.4 KB (~7K) | **~52K tokens** |
| **Lean** | `"Bash,Read,Edit"` | 20.1 KB | 15.6 KB (~3.9K tokens) | 1.1 KB (~275) | **~5K tokens** |
| **Savings** | | -184.7 KB | -101.3 KB (-25K tokens) | -26.3 KB (-6.6K) | **-47K tokens/turn** |

> **90% reduction** with 3-tool lean profile. System prompt also shrank because `Agent`'s
> runtime template injection no longer fires.

---

## Recommended Tool Profiles

### Lean (scripts, `-p` mode, AO workers)
```
--tools "Bash,Read,Write,Edit,Glob,Grep"
```
~6K tokens/turn for tool defs. Drops Agent, Teams, Tasks, Scheduling, Worktree, Web.

### Standard (most interactive sessions)
```
--tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode,NotebookEdit"
```
~9K tokens/turn. Adds web and plan mode. Still excludes Agent, Teams, Tasks, Cron (~13K tokens saved vs default).

### Full minus orchestration (power sessions without team features)
```
--tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode,NotebookEdit,Agent,Skill,EnterWorktree,ExitWorktree"
```
~15K tokens/turn. Adds sub-agents and worktrees. Drops Teams, Tasks, Cron (~7K tokens saved vs default).

### Default (current behavior — no flag)
All 27 tools: ~22K tokens/turn for built-in tool defs alone.

---

## Tool Include/Exclude Rationale

| Tool(s) | Include? | Reason |
|---------|----------|--------|
| `Read, Write, Edit, Bash, Glob, Grep` | ✅ Always | Core coding — no session works without these |
| `WebFetch, WebSearch` | ✅ Interactive | Docs lookups; cheap (~950 tokens combined) |
| `AskUserQuestion` | ✅ Interactive | Needed for plan mode; Claude won't ask without it |
| `EnterPlanMode, ExitPlanMode` | ✅ Interactive | 7K tokens saved if excluded, but disables plan workflow |
| `NotebookEdit` | ⚡ Optional | Only needed for Jupyter work; 1.5K tokens |
| `Agent` | ⚡ When needed | Expensive (4.6K tokens) but enables sub-agent delegation |
| `Skill` | ⚡ When needed | Needed to invoke slash skills; ~425 tokens |
| `EnterWorktree, ExitWorktree` | ⚡ When needed | Only useful with `ao spawn`-style workflows |
| `TaskCreate/Update/Get/List/Output/Stop` | ❌ Lean sessions | 2.8K tokens; only useful in long multi-step sessions |
| `TeamCreate, TeamDelete, SendMessage` | ❌ Solo sessions | 2.7K tokens; only for multi-agent team workflows |
| `CronCreate, CronDelete, CronList` | ❌ Most sessions | ~1K tokens; only for scheduling recurring prompts |
| `RemoteTrigger` | ❌ Most sessions | ~250 tokens; only for remote trigger API |

---

## `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` — Agent Defs On Demand?

Found in binary analysis: `R17()` checks this env var to decide whether agent definitions are
embedded inline in the `Agent` tool description or deferred to `system-reminder` messages.

```bash
export CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=1
```

**Measured result (live capture):**

| Mode | Agent tool def | All tool defs | Total request |
|------|---------------|---------------|---------------|
| Default (inline) | 18.5 KB (~4.6K tokens) | 119.7 KB (~30K tokens) | 205 KB (~52K tokens) |
| `AGENT_LIST_IN_MESSAGES=1` | 6.9 KB (~1.7K tokens) | 108.2 KB (~27K tokens) | 212 KB (~54K tokens) |
| Delta | **-11.5 KB (-2.9K tokens)** | **-11.5 KB (-2.9K tokens)** | **+7 KB (+1.8K tokens)** ⚠️ |

**Conclusion:** This is a **relocate, not eliminate**. Agent definitions move from the tool payload into
system-reminder messages. In `-p` mode the system-reminder fires on turn 1 regardless, so total request
size is slightly *larger*. In long interactive sessions where `Agent` is rarely invoked, it may defer
the injection — but this is unconfirmed. The `Agent` tool def itself shrinks from 4.6K → 1.7K tokens.

GrowthBook default: `false` (inline). Override with env var or wait for Anthropic to flip the experiment.

---

## Other Overhead Reduction Options

| Lever | Savings | Notes |
|-------|---------|-------|
| `--tools` lean profile | ~16K tokens/turn | Largest single lever; measured |
| `--strict-mcp-config` whitelist | ~5–7K tokens/turn | Eliminates unused MCP tool defs |
| Trim `~/.claude/CLAUDE.md` | ~250 tokens per KB removed | Current overhead ~2K tokens |
| Reduce `~/.claude/agents/` count | ~100 tokens/agent | Each `.md` inflates `Agent` tool def |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=1` | -2.9K tokens from tool def | Total may increase; see section above |
| Compact `MEMORY.md` / skills listing | ~500 tokens | Skills listing injected every turn |

---

## Environment

- **Platform:** macOS (Darwin 24.5.0)
- **Claude Code version:** v2.1.98
- **Capture proxy:** llm-inspector → ccproxy → Anthropic API
- **Token conversion:** `bytes / 4` (JSON/code payloads), `bytes / 3.5` (prose)
