# Raw HTTP Captures

Captured using mitmproxy on port 8888 with a custom addon that intercepts and records:
- Full raw HTTP request (headers + body)
- Full raw HTTP response (headers + body, SSE format)
- Parsed JSON bodies

## Files

- `capture_*.json` — Raw capture data (full HTTP request + response)
- `capture-sonnet.md` — Human-readable Sonnet capture summary
- `capture-opus.md` — Human-readable Opus capture summary
- `capture-haiku.md` — Human-readable Haiku capture summary

## Collection Method

```bash
# Start mitmproxy on port 8888
mitmdump --set listen_port=8888 -s mitm_addon.py

# In another terminal, run Claude Code through the proxy
export HTTPS_PROXY=http://127.0.0.1:8888
export HTTP_PROXY=http://127.0.0.1:8888
export NODE_TLS_REJECT_UNAUTHORIZED=0
claude -p --dangerously-skip-permissions --model sonnet "say hello"
```

## Capture Format

Each JSON capture contains:
- `timestamp` — Unix timestamp in ms
- `capture_time` — ISO 8601 UTC time
- `request.raw` — Full HTTP request as raw string
- `request.body_parsed` — Parsed JSON request body
- `response.raw` — Full HTTP response as raw string
- `response.body_parsed` — Parsed JSON (response SSE events parsed)
- `response.body_raw` — Raw SSE response text
