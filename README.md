# llm-inspector

Capture and analyze LLM API request payloads. Understand what's eating your context window.

## Quick Start

```bash
npx llm-inspector start
# In another terminal, use your LLM tool:
ANTHROPIC_BASE_URL=http://localhost:9000 claude --print "hello"
# Then analyze:
npx llm-inspector analyze
```

## Install

```bash
npm install -g llm-inspector
```

## Commands

| Command | Description |
|---|---|
| `llm-inspector start` | Start the capture proxy on port 9000 |
| `llm-inspector stop` | Stop the capture proxy |
| `llm-inspector analyze` | Analyze captured requests and show token breakdown |
| `llm-inspector analyze --json` | Output analysis as JSON |
| `llm-inspector clean` | Remove captured request files |

## What It Measures

Every LLM API call includes overhead beyond your actual prompt:

| Component | Typical Size |
|---|---|
| Tool definitions | ~26K tokens (49%) |
| System prompt | ~8K tokens (15%) |
| CLAUDE.md / instructions | ~8.5K tokens (16%) |
| MCP tool definitions | ~8K tokens (15%) |
| Skills list | ~2K tokens (4%) |

## How It Works

1. Starts a transparent HTTP proxy that captures full request/response payloads
2. Forwards requests to the actual LLM API (supports Anthropic, OpenAI, any OpenAI-compatible)
3. Analyzes captured payloads to break down token usage by component

## Upstream Support

Works with any tool that supports `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`:
- Claude Code CLI
- OpenAI CLI
- Cursor
- Any OpenAI-compatible client

## Requirements

- Node.js 18+
- An existing LLM API setup (API key or OAuth proxy like ccproxy)

## License

MIT
