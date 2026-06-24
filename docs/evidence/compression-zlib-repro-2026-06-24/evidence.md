# Evidence Summary — Proxy Decompression & Side-by-Side Verification

## Verdict: PASS

**Claim class**: Layer 2 real-callstack + real-LLM (real Claude Code CLI session through proxy) and Layer 2 mock-at-network (mock upstream side-by-side test verification)
**Date**: 2026-06-24
**Test runner**: `scripts/test-side-by-side.mjs` and real `claude --print` execution

## What Makes This "Real"

- **Actual HTTP POST** through the proxy to the real Anthropic API during the Claude Code session.
- **Transparent gunzip** verification: the real Claude Code client requests gzip-compressed streams; the proxy decompresses them in real-time, preventing the client from crashing with `Decompression error: ZlibError`.
- **Side-by-side test**: a local TCP mock upstream verifies the correctness of headers, payload sizes, on-demand re-issue loops, and stream deduplication under load.

## Test Results

| Test Scenario | Result | Detail |
|---------------|--------|--------|
| Side-by-Side verification runner | ✅ PASS | Verified 86.2% payload reduction and 86.5% tool definition reduction. |
| Real Claude Code turn integration (Fibonacci) | ✅ PASS | Decompressed streaming gzip response and generated correct code. |

## What This Evidence Proves

- **Decompression Fix**: The proxy successfully intercepts and decompresses responses when the upstream ignores the client's identity preference and returns gzip-compressed bytes.
- **No Stream Duplication**: The client receives each SSE chunk exactly once without duplicated stream markers.
- **On-Demand Re-issue**: The proxy suspends requests with stubbed schemas and correctly fetches the full schema when the model calls the stubbed tool.
- **Payload Savings**: Deleting unneeded Chrome tools and stubbing heavy workspace tools reduces payload sizes by >80%.

## What This Evidence Does NOT Prove

- Behavior with extremely large, multi-minute streaming sessions (which could be subject to connection timeouts).
- Support for Brotli (`br`) compression (which is not currently used by Anthropic's endpoints).

## Claim -> Artifact Map

| Claim | Artifact | Key Field / Verification |
|-------|----------|--------------------------|
| Side-by-side verification | `run.json` | `scenarios[0].pass = true` |
| Real task execution (Fibonacci) | `artifacts/fibonacci-capture.json` | Real request and response chunks logged under `response_raw` |
| Gzip decompression | `artifacts/fibonacci-capture.json` | `headers["accept-encoding"] = "gzip, deflate, br, zstd"`, decompressed stream in `response_raw` |
| Side-by-side script | `artifacts/test-side-by-side.mjs` | Test runner source code |
