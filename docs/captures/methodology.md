# Evidence Methodology

## Collection Context
- **Date**: 2026-04-20
- **Git SHA**: 3e9fe28ecd27292619003d19c71fb3efc8ec75cb
- **Capture Proxy**: port 9000 → ccproxy-api port 8001 → Anthropic API
- **Process IDs**: node 8501 (capture proxy), Python 91279 (ccproxy-api)

## Claims
1. A Claude Code `/v1/messages` request was captured with full request body
2. System prompt extraction produces valid Claude Code system instructions
3. Response status codes are captured
4. Multiple independent sessions produce distinct captures

## Artifacts
- 6 markdown captures (`capture-2026-04-21T05-*.md`) — Full raw HTTP request/response for Sonnet (×4), Opus (×1), Haiku (×1)
- Source JSON captures at `~/.llm-inspector/captures/capture-2026-04-21T05-*.json`

## Verification
- SHA256 checksums computed for all artifacts
- Independent sessions verified via timestamps and session IDs
