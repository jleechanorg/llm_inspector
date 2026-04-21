# LLM Inspector Captures

Raw HTTP captures from llm-inspector's capture proxy, verifying full `request_raw` and `response_raw` field capture.

## Capture Format

Each `.json` capture contains:
- `timestamp` — ISO 8601 UTC
- `method`, `path`, `url` — HTTP request line
- `headers` — Redacted HTTP headers
- `body` — Parsed JSON request body (tools, messages, system prompt)
- `bodySize` — Raw body size in bytes
- `request_raw` — Full raw HTTP request (HTTP/1.1 headers + body)
- `response` — `{ status, body, usage }` from parsed response
- `response_raw` — Full raw HTTP response (HTTP/1.1 status + headers + SSE body)

## Captures

| Model | File | Request Raw | Response Raw | Tokens (in/out) |
|-------|------|-------------|--------------|------------------|
| Sonnet 4-6 | `capture-2026-04-21T05-34-34...` | 193,636 B | 2,890 B | 3 / 12 |
| Sonnet 4-6 | `capture-2026-04-21T05-36-19...` | 193,639 B | 2,857 B | 3 / 12 |
| Sonnet 4-6 | `capture-2026-04-21T05-44-11...` | 201,580 B | 2,854 B | 3 / 12 |
| Sonnet 4-6 | `capture-2026-04-21T05-48-58...` | 193,816 B | 2,831 B | 3 / 12 |
| Opus 4-7 | `capture-2026-04-21T05-49-18...` | 201,571 B | 2,438 B | 6 / 8 |
| Haiku 4-5 | `capture-2026-04-21T05-49-32...` | 201,564 B | 4,473 B | 10 / 99 |

## Verification

Both `request_raw` and `response_raw` are confirmed as valid HTTP/1.1 formatted strings:
- `request_raw` starts with `POST /v1/messages?beta=true HTTP/1.1`
- `response_raw` starts with `HTTP/1.1 200 OK`
- Both end with proper body content (request JSON body / SSE event stream)

## Notes

- `response_raw` captures the full SSE event stream including `message_start`, `content_block_delta`, `message_delta`, and `message_stop` events
- `request_raw` includes the full system prompt injection (~26KB), tool definitions, and conversation messages
- Captures collected via `npm run start -- --upstream http://127.0.0.1:8001` routing through ccproxy-api on port 8001
