# Evidence Summary — Proxy Decompression & Side-by-Side Verification

## Verdict: PASS

**Claim class**: Layer 2 real-callstack + real-LLM (real Claude Code CLI session through proxy) and Layer 2 mock-at-network (mock upstream side-by-side test verification and Vitest integration test)
**Date**: 2026-06-24
**Test runners**: `scripts/test-side-by-side.mjs`, `src/proxy.test.ts`, and real `claude --print` execution

## What Makes This "Real"

- **Actual HTTP POST** through the proxy to the real Anthropic API during the Claude Code session.
- **In-Process Integration Test**: Uses Vitest to spin up a mock upstream returning gzip-compressed response bytes and verifies that the proxy decompresses them, strips headers, and delivers plain text to the client.

## Test Results

| Test Scenario | Result | Detail |
|---------------|--------|--------|
| Side-by-Side verification runner | ✅ PASS | Verified 86.2% payload reduction and 86.5% tool definition reduction. |
| Real Claude Code turn integration (Fibonacci) | ✅ PASS | Proxy correctly forwards a real Claude Code session end-to-end with no ZlibError. (Note: Upstream returned uncompressed stream; decompression path was not active). |
| Vitest Integration Decompression Test | ✅ PASS | Mock upstream returns gzipped bytes; verified that the proxy correctly decompresses it, strips the content-encoding, and forwards plain text. |

## What This Evidence Proves

- **Decompression Fix**: The proxy successfully intercepts and decompresses responses when the upstream returns gzip-compressed bytes (proven by the Vitest integration test).
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
| Real task execution (Fibonacci) | `artifacts/fibonacci-capture.json` | Real request and response chunks logged under `response_raw` (plain text) |
| Gzip decompression fix | `artifacts/proxy.test.ts`, `artifacts/vitest-run.log` | Test `transparently decompresses gzip responses from upstream...` passes in log |
| Side-by-side script | `artifacts/test-side-by-side.mjs` | Test runner source code |
