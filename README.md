# llm-inspector

Capture and analyze LLM API request payloads. Understand what's eating your context window.

## Architecture

`llm-inspector` requires two components:

| Component | Role | Install |
|---|---|---|
| [ccproxy-api](https://github.com/aistackhq/ccproxy) | OAuth proxy — handles Anthropic/Claude auth | Python (uv/pip) |
| llm-inspector | Capture proxy + analyzer | Node.js (npm) |

The capture chain is:

```
Your tool → llm-inspector :9000 (captures payloads) → ccproxy :8000 (OAuth) → Anthropic API
```

`llm-inspector` intercepts every request, saves the full JSON payload to disk, and forwards it through `ccproxy` to the real API. The analyzer then breaks down what's consuming your context tokens.

## Install

### One-liner (installs both)

```bash
curl -fsSL https://raw.githubusercontent.com/jleechanorg/llm_inspector/main/install.sh | bash
```

Or clone and run:

```bash
git clone https://github.com/jleechanorg/llm_inspector.git
cd llm_inspector
./install.sh
```

### Manual install

**Step 1 — ccproxy-api** (Python):

```bash
# With uv (recommended):
uv tool install ccproxy-api

# Or with pip:
pip install ccproxy-api
```

**Step 2 — llm-inspector** (Node.js 18+):

```bash
npm install -g llm-inspector
```

**Step 3 — Configure ccproxy**:

```bash
# Authenticate with Claude OAuth:
ccproxy auth refresh claude-api

# Or set up with an API key — edit ~/.ccproxy/config.yaml:
#   api_key: env/ANTHROPIC_API_KEY
```

## Quick Start

```bash
# 1. Start the capture chain (ccproxy + llm-inspector proxy)
llm-inspector start

# 2. Route your tool through the capture proxy
export ANTHROPIC_BASE_URL=http://localhost:9000

# 3. Use Claude Code, run a script, etc.
claude --print "What is 2+2?"

# 4. Analyze what was captured
llm-inspector analyze
```

## Commands

| Command | Description |
|---|---|
| `llm-inspector start` | Start the capture proxy on port 9000 |
| `llm-inspector start --port 9001` | Use a different port |
| `llm-inspector start --foreground` | Run in foreground (don't detach) |
| `llm-inspector stop` | Stop the capture proxy |
| `llm-inspector analyze` | Show token breakdown for all captures |
| `llm-inspector analyze --last 5` | Only analyze the last 5 captures |
| `llm-inspector analyze --sort tokens` | Sort by estimated token count |
| `llm-inspector analyze --json` | Output as JSON |
| `llm-inspector status` | Check if proxy is running, show capture count |
| `llm-inspector clean` | Remove all captured request files |

## What It Measures

Every LLM API call includes overhead beyond your actual prompt. For a simple Claude Code session:

| Component | Typical Size | Notes |
|---|---|---|
| Built-in tool definitions | ~26K tokens (49%) | Agent, Bash, TeamCreate, etc. |
| System prompt | ~8K tokens (15%) | Injected by Claude Code |
| CLAUDE.md stack | ~8.5K tokens (16%) | Global + project instructions |
| MCP tool definitions | ~8K tokens (15%) | Depends on MCP servers enabled |
| Skills list | ~2K tokens (4%) | Registered slash commands |
| **Total overhead** | **~53K tokens** | Before any user content |

Real baseline measured from a Claude Code session (claude-haiku, `What is 2+2?`):

```
Component           Bytes      ~Tokens    %
─────────────────────────────────────────────
builtin_tools       91,932     26,266     49%
system_prompt       28,113      8,032     15%
claude_md_stack     30,010      8,574     16%
mcp_tools           27,694      7,913     15%
skills_list          7,164      2,047      4%
─────────────────────────────────────────────
TOTAL              184,913     52,832    100%
```

## How the Chain Works

```
Claude Code
    │
    │  ANTHROPIC_BASE_URL=http://localhost:9000
    ▼
llm-inspector proxy (:9000)
    │  saves full request JSON to ~/.llm-inspector/captures/
    │  captures: tool defs, messages, system prompt, model, headers
    │
    │  upstream: http://localhost:8000 (ccproxy)
    ▼
ccproxy (:8000)
    │  handles OAuth token refresh
    │  routes to correct model
    ▼
Anthropic API
```

## Requirements

- Node.js 18+
- Python 3.9+ (for ccproxy-api)
- `uv` or `pip` (for ccproxy-api install)
- An Anthropic account (OAuth or API key via ccproxy)

## License

MIT
