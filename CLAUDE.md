# llm-inspector

Captures and analyzes LLM API request payloads to understand context window usage.

## Architecture

```
Claude Code → llm-inspector :9000 → ccproxy :8001 → Anthropic/MiniMax API
```

- **Port 9000**: Capture proxy (this repo) - captures full HTTP request/response bytes to disk
- **Port 8001**: ccproxy-api (Python) - handles OAuth token refresh and routes to Anthropic/MiniMax API
- **Start**: `npm run start -- --upstream http://127.0.0.1:8001`
- Raw HTTP fields: `request_raw` (full HTTP request) and `response_raw` (full HTTP response)

## Key Files

- `src/` - TypeScript source
- `docs/` - Documentation
- `docs/raw-http/` - Raw HTTP captures from mitmproxy

## Commands

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run start     # Start capture chain (pass --upstream http://127.0.0.1:8001)
```

## Tech Stack

- TypeScript
- Node.js 18+
- Python 3.9+ (for ccproxy-api)

# RTK (Rust Token Killer)

**Always prefix commands with `rtk`** — passthrough if no filter. See `~/.claude/RTK.md` for full command reference (60-90% token savings on git, gh, tests, build, docker, etc).