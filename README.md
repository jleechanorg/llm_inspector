# llm-inspector

Capture and analyze LLM API request payloads. Understand what's eating your context window.

## How It Works

`llm-inspector` wraps [ccproxy-api](https://github.com/aistackhq/ccproxy) and adds a capture layer:

```
Claude Code
    │  ANTHROPIC_BASE_URL=http://localhost:9000
    │  ANTHROPIC_API_KEY=oauth-proxy
    ▼
llm-inspector :9000   ← captures full JSON request payloads to disk
    │  forwards to http://127.0.0.1:8000/claude
    ▼
ccproxy :8000         ← handles OAuth token refresh → Anthropic API
    ▼
Anthropic API
```

`llm-inspector start` starts ccproxy automatically if it isn't already running.

## Install

**Requirements:** Node.js 18+, Python 3.9+

### One-liner (installs both ccproxy-api and llm-inspector, sets up auto-start via launchd)

```bash
curl -fsSL https://raw.githubusercontent.com/jleechanorg/llm_inspector/main/scripts/llm-inspector-install.sh | bash
```

### Or run locally after cloning

```bash
git clone https://github.com/jleechanorg/llm_inspector.git
cd llm_inspector
./scripts/llm-inspector-install.sh
```

The install script:
1. Installs `ccproxy-api` (Python OAuth proxy) via `uv` or `pip`
2. Builds the llm-inspector Node.js package
3. Creates a launchd agent (`~/Library/LaunchAgents/com.jleechan.llm-inspector.plist`) for auto-start on login
4. Loads the launchd agent
5. Creates `~/.ccproxy/config.yaml` with default settings
6. Refreshes the OAuth token

After install, add to your shell profile (`~/.zshrc`):

```bash
export ANTHROPIC_BASE_URL=http://localhost:9000
export ANTHROPIC_API_KEY=oauth-proxy
```

### Manual install (without launchd)

```bash
# 1. Install ccproxy-api (Python OAuth proxy)
uv tool install ccproxy-api   # or: pip install ccproxy-api

# 2. Authenticate ccproxy with Claude OAuth
ccproxy auth refresh claude-api

# 3. Install llm-inspector
npm install -g /path/to/llm_inspector

# 4. Start manually
llm-inspector start
```

## Quick Start

```bash
# Start capture chain (starts ccproxy + capture proxy)
llm-inspector start

# Route Claude Code through it
export ANTHROPIC_BASE_URL=http://localhost:9000
export ANTHROPIC_API_KEY=oauth-proxy

# Make a request
claude --print "What is 2+2?"

# See what was captured
llm-inspector analyze
```

## What It Measures

Baseline from a real Claude Code session (`claude --print "What is 2+2?"`, claude-haiku):

| Component | Bytes | ~Tokens | % |
|---|---|---|---|
| Built-in tool definitions | 91,932 | ~26,266 | 49% |
| System prompt | 28,113 | ~8,032 | 15% |
| CLAUDE.md stack | 30,010 | ~8,574 | 16% |
| MCP tool definitions | 27,694 | ~7,913 | 15% |
| Skills list | 7,164 | ~2,047 | 4% |
| **Total overhead** | **184,913** | **~52,832** | **100%** |

This is the overhead before any user content. At ~53K tokens per turn, a 200K context window fills in ~3 turns without compaction.

## Commands

| Command | Description |
|---|---|
| `llm-inspector start` | Start capture chain (ccproxy + capture proxy) on port 9000 |
| `llm-inspector start --upstream <url>` | Skip ccproxy, forward directly to a URL |
| `llm-inspector start --foreground` | Run in foreground |
| `llm-inspector stop` | Stop the capture proxy |
| `llm-inspector status` | Check if running, show capture count |
| `llm-inspector analyze` | Show token breakdown for all captures |
| `llm-inspector analyze --last 5` | Only analyze last 5 captures |
| `llm-inspector analyze --sort tokens` | Sort by estimated token count |
| `llm-inspector analyze --json` | Output as JSON |
| `llm-inspector clean` | Remove all captured request files |

## ccproxy Setup

ccproxy handles OAuth with the Anthropic API. After installing:

```bash
# Authenticate (opens browser for OAuth flow)
ccproxy auth login

# Or refresh an existing token
ccproxy auth refresh claude-api
```

Config lives at `~/.ccproxy/config.yaml`. The default model entry should have `api_key: claude-api` to use OAuth.

## License

MIT
