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
- `full-capture-sample.json` - Complete request/response capture from Sonnet review session
- `system-prompt-001.txt` - Extracted system prompt (first session)
- `system-prompt-002.txt` - Different session's system prompt
- `metadata.json` - Collection provenance and checksums

## Verification
- SHA256 checksums computed for all artifacts
- Independent sessions verified via timestamps and session IDs
