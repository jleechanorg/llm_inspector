# llm-inspector vs ccproxy Native Plugins

**Date:** 2026-04-10  
**Question:** Does llm-inspector's custom capture proxy duplicate what ccproxy already provides via built-in plugins?

---

## tl;dr

**No — they solve different problems.** ccproxy's plugins give you raw HTTP access logs and traces. llm-inspector gives you **per-request component-level token accounting** (built-in tool defs vs MCP vs system prompt vs CLAUDE.md stack, with byte/token estimates per component). That analysis is what makes the tool useful for diagnosis, not just logging.

---

## Capability Comparison

| Capability | ccproxy `access_log` | ccproxy `request_tracer` | llm-inspector |
|-----------|----------------------|------------------------|---------------|
| **Captures full request body** | ❌ (metadata only) | ✅ (raw HTTP) | ✅ (parsed JSON) |
| **Component-level breakdown** | ❌ | ❌ | ✅ |
| **Built-in vs MCP tool splitting** | ❌ | ❌ | ✅ |
| **Token estimate per component** | ❌ | ❌ | ✅ |
| **System prompt vs CLAUDE.md splitting** | ❌ | ❌ | ✅ |
| **Structured JSON logs** | ✅ | ✅ | ❌ (files only) |
| **Claude Code → ccproxy OAuth chain** | ✅ | ✅ | ✅ (via ccproxy) |
| **CLI (start/stop/analyze/clean)** | ❌ | ❌ | ✅ |
| **No custom code needed** | ✅ | ✅ | ❌ (Node.js proxy) |

---

## What ccproxy Plugins Provide

### access_log plugin
```
[plugins.access_log]
enabled = true
client_enabled = true
client_format = "structured"   # or "common", "combined"
client_log_file = "/tmp/ccproxy/access.log"
provider_enabled = false
provider_format = "structured"
provider_log_file = "/tmp/ccproxy/provider_access.log"
```
Logs HTTP metadata: method, path, status code, bytes, timestamp. **Not the request body.**

### request_tracer plugin
```
[plugins.request_tracer]
enabled = true
json_logs_enabled = true
raw_http_enabled = true
log_dir = "/tmp/ccproxy/traces"
```
Captures raw HTTP requests/responses including bodies. Useful for debugging but:
- No component analysis — just raw dumps to files
- You still need to manually parse the JSON to understand token distribution
- No tool def categorization (built-in vs MCP)

---

## What llm-inspector Does That ccproxy Doesn't

llm-inspector's value is the **analyzer** — a ~300 LOC module that takes a captured JSON request and produces:

```
=== LLM Inspector Analysis ===
Request 1: claude-haiku-4-5-20251001 (187,060 bytes, ~53K tokens)

Component                Bytes      ~Tokens   %
───────────────────────────────────────────────────
System prompt            28,113     8,032    15%
CLAUDE.md / instructions 20,400     5,829    11%
Skills list              7,164      2,047     4%
Built-in tool defs (31)  91,932     26,266   49%
MCP tool defs (26)        27,694     7,913    15%
User messages            3,218      920      2%
TOTAL                   187,060    52,832   100%

  Agent                    18,481   5,280    10%
  Bash                     11,737   3,353    6%
  mcp-agent-mail (16)      22,584   6,453    12%
  ...
```

This is what tells you:
- `Agent` tool alone is 10% of your per-turn overhead (~4.6K tokens)
- MCP tools are 15% — and which MCP server is the biggest contributor
- Your CLAUDE.md stack is 11%

**You can't get this from access logs or raw HTTP traces without custom post-processing.**

---

## Could ccproxy Replace llm-inspector?

**For logging/capture:** Mostly yes. ccproxy's `request_tracer` gives you raw HTTP captures that include the full JSON body.

**For analysis:** No. You'd need to either:
1. Write post-processing scripts to parse the raw traces (replicating llm-inspector's analyzer)
2. Use `ccproxy plugins list` + `ccproxy status` (high-level stats only)

**For the specific workflow in this repo** (understanding ~53K tokens/turn overhead, `--tools` flag savings, MCP trim potential): the component-level analysis is the core value. Raw HTTP logs don't answer the question "which component is eating my context."

---

## The Real Question: Architecture

llm-inspector is a thin capture proxy (~150 LOC proxy.ts) + a focused analyzer (~300 LOC analyzer.ts). The proxy just saves JSON and forwards. The analyzer does the work.

If ccproxy added a **payload_analyzer plugin** that computed component-level token estimates from request bodies, llm-inspector could drop its proxy and become a pure analysis CLI on top of ccproxy traces.

Until then, llm-inspector fills that gap.

---

## Bottom Line

| Use case | Use ccproxy native plugins |
|----------|---------------------------|
| OAuth → Anthropic proxy | ✅ ccproxy |
| Raw HTTP access logging | ✅ `access_log` plugin |
| Raw request/response traces for debugging | ✅ `request_tracer` plugin |
| Understanding which component (tools/MCP/system/CLAUDE.md) is consuming context | ❌ Use llm-inspector |
| Measuring `--tools` flag token savings | ❌ Use llm-inspector |
| Diagnosing why context fills in 3 turns | ❌ Use llm-inspector |

They're complementary. ccproxy handles the infrastructure (OAuth, proxy, raw logging). llm-inspector handles the analysis layer on top.

---

## Recommendation

Keep llm-inspector as the analysis layer. It could optionally consume ccproxy's raw trace output as an alternative input format, making the capture proxy an optional component.

**Files:**
- `llm_inspector/src/proxy.ts` — capture proxy (~150 LOC)
- `llm_inspector/src/analyzer.ts` — component-level analysis (~300 LOC) ← core value
- `llm_inspector/src/cli.ts` — start/stop/analyze/clean/status CLI
