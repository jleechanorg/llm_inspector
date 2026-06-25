# Evidence — PR #12 gzip re-issue + PR #10 mid-stream fix + SHA-256 replay oracle

## Summary

PR #12 ships three correctness fixes for `jleechanorg/llm_inspector`:

1. **reIssueWithFullSchema gzip decompression** — on-demand mode was broken
   whenever upstream returned `content-encoding: gzip` on the re-issued
   request. The function used `Buffer.concat(chunks).toString("utf-8")`
   which returns gzip bytes decoded as utf-8 (mojibake) propagated to
   the client.

2. **PR #10 mid-stream regression test** — covers the
   `if (!res.headersSent)` guards PR #10 added at proxy.ts:756 (gunzip
   error) and proxy.ts:787 (proxyRes error). Pre-PR #10: proxy would
   crash with "Cannot set headers after they are sent" when upstream
   errored mid-stream after partial response flush.

3. **SHA-256 replay oracle test** — closes the /es C6 (HIGH) gap. Asserts
   that request bytes are byte-transparent across the proxy:
   `sha256(client_sent) === sha256(upstream_received) === sha256(capture_file.request_raw)`.

## Claim → Artifact Map

| # | Claim                                                                                                | Verification                                                                                                                                                          | Artifact(s)                                                                              | Layer     |
|---|------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|-----------|
| 1 | reIssueWithFullSchema decompresses gzipped upstream responses before returning                       | vitest `decompresses gzipped re-issue response in on-demand mode (regression)` — mock upstream gzips re-issued response; client receives plain SSE "re-issued success"  | `artifacts/vitest-verbose.log`; `artifacts/vitest-run.log`                                | Layer 2 mock-at-network |
| 2 | PR #10 mid-stream error guard prevents "Cannot set headers" crash                                    | vitest `survives mid-stream upstream error after partial response (PR #10 regression)` — dedicated upstream destroys mid-stream after 10ms; `process.on("uncaughtException")` listener never fires | `artifacts/vitest-verbose.log`; `src/proxy.ts:756, 787` for the guard logic                | Layer 2 mock-at-network |
| 3 | Proxy preserves request bytes byte-for-byte (no silent mutation)                                     | vitest `preserves request bytes byte-for-byte: client = upstream = capture (SHA-256 replay oracle)` — all three SHA-256 digests must match                            | `artifacts/vitest-verbose.log`; SHA-256 of frozen oracle payload: `92bc7bd1726eefb2a3bbcfb22e76e95660cde87d17a5bfdd2976678865f78a6e` | Layer 2 mock-at-network |
| 4 | Side-by-side token savings hold post-fix                                                             | `npm run test:side-by-side` — observe vs `lean,on-demand`: 86.2% payload reduction, 86.5% tool def reduction, no duplicate chunks, re-issue success                    | `methodology.md` § "Side-by-side"; (deterministic each run — no captured log)              | Layer 2 mock-at-network |
| 5 | Build is reproducible (artifacts sha256-stable)                                                      | `dist/cli.js` and `dist/cli.d.ts` SHA-256 captured                                                                                                                    | `artifacts/cli.js.sha256`, `artifacts/cli.d.ts.sha256`                                    | Layer 1   |
| 6 | Real Claude Code session ran successfully through the proxy (pre-PR #12, prior bundle)               | prior evidence bundle `compression-zlib-repro-2026-06-24` documented `claude --print "Write a python function to compute fibonacci."` exited 0 with correct output   | `~/projects_other/llm_inspector/docs/evidence/compression-zlib-repro-2026-06-24/evidence.md` | Layer 3 real-LLM |

## Test counts

- **Total vitest tests**: 125
- **CI runs (Node 20)**: success
- **CI runs (Node 22)**: success
- **Side-by-side**: PASS

## Build artifact SHA-256

- `dist/cli.js`: `569f2b9032c5be63fa775090ef26fb746e7540dec6a0563d1bfef325ea33430f`
- `dist/cli.d.ts`: `a59c47872b71f12589942892464e764c0db350c20b72228645615cc36e0a0725`

## SHA-256 replay oracle — the bar

The SHA-256 replay oracle test (`preserves request bytes byte-for-byte`) is
the canonical proxy-correctness test per `/es` standards. Frozen payload:

```json
{"model":"claude-3-5-sonnet","tools":[{"name":"Bash","description":"shell tool"}],"messages":[{"role":"user","content":"oracle-test-payload-2026-06-25"}]}
```

Frozen SHA-256: `92bc7bd1726eefb2a3bbcfb22e76e95660cde87d17a5bfdd2976678865f78a6e`.

If a future change to `src/proxy.ts` silently mutates the request body
(re-order headers, alter JSON key order, drop a field, etc.), this test
will fail. This is the assertion that `compression-zlib-repro-2026-06-24`
lacked and that PR #9's review identified as the #1 missing test.

## What This Evidence Does NOT Prove

- **Real-LLM Layer 3** — this bundle does NOT include a fresh real-task
  Claude Code session through the post-fix proxy. The prior bundle
  (`compression-zlib-repro-2026-06-24`) does, but the gzip fix landed after
  that bundle was sealed. A follow-up bundle would re-run
  `claude --print <prompt>` through the proxy and assert capture-file
  round-trip equality. Defer until next session.
- **PR #10 listener-leak fix** — the `req.off("close", onClientClose)`
  cleanup at the three timeout handlers (proxy.ts:251, 474, 955) is
  not covered by a regression test. The hardcoded 120s timeout makes
  direct testing impractical without injecting a timeout knob. PR #10
  was merged with the fix verified by code review only. Follow-up:
  add a `timeoutMs` parameter to `startProxy` and a leak-detection test.
- **Brotli / deflate handling** — `reIssueWithFullSchema` now handles
  gzip only. Brotli/deflate deferred to match the existing TODO in
  the `startProxy` response handler.
- **High-volume concurrent traffic** — the SHA-256 oracle runs a single
  request. Concurrent-request coverage would catch the `requestBuffers`
  Map race and `saveCapture` filename collision if they exist.
- **analyzer.ts, cli.ts, utils.ts** — 0% test coverage on these files
  (391 + 321 + 263 LOC). Pre-PR-#11 they had no CI gate either. PR #11
  gave them a CI gate, but no tests exist to fail under that gate.
