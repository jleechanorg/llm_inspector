# llm-inspector

Captures and analyzes LLM API request payloads to understand context window usage.

## Architecture

```
Claude Code → llm-inspector :9000 → ccproxy :8000 → Anthropic API
```

- **Port 9000**: Capture proxy (this repo) - captures full JSON request payloads to disk
- **Port 8000**: ccproxy - handles OAuth token refresh
- `llm-inspector start` auto-starts ccproxy if not running

## Key Files

- `src/` - TypeScript source
- `docs/` - Documentation
- `install.sh` - Installation script

## Commands

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
llm-inspector start  # Start capture chain
```

## Tech Stack

- TypeScript
- Node.js 18+
- Python 3.9+ (for ccproxy-api)
