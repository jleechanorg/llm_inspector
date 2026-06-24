# Methodology Summary — Proxy Decompression & Side-by-Side Verification

## Environment
- OS: macOS
- Runtime: Node.js (v22.22.0), Bun (v1.4.0)
- Client: Claude Code CLI (`claude-cli/2.1.185`, external, sdk-cli)
- Proxy Port: 9000
- Upstream Mock Port: 18888

## Automated Side-by-Side Test Verification
- Executed via `npm run test:side-by-side` (running `scripts/test-side-by-side.mjs`).
- Creates a mock upstream HTTP server on port 18888 and proxy instance on port 18889.
- Sends a test payload with 3 heavy/mock tools (Agent, mcp__claude-in-chrome__computer, Bash) in `observe` and `lean,on-demand` modes.
- Asserts that:
  - Total payload size reduction >= 15% (Measured: 86.2%).
  - Tool definitions reduction >= 8% (Measured: 86.5%).
  - Zero stream chunk duplication (occurrences === 1).
  - On-demand re-issue successfully fetches full tool schema when stubbed tools are triggered.

## Real-Task Claude Code Integration Test
- Cleaned all old captures first via `node dist/cli.js clean`.
- Routed a real Claude Code session through the active proxy using:
  ```bash
  export ANTHROPIC_BASE_URL=http://localhost:9000
  claude --print "Write a python function to compute fibonacci."
  ```
- Checked that:
  - The real CLI ran successfully, exited code 0, and printed correct fibonacci code.
  - The capture files were successfully generated in `~/.llm-inspector/captures/`.
  - Inspected the JSON capture file to verify that the request and response gzip-compressed bytes were correctly intercepted, decoded, and logged.
