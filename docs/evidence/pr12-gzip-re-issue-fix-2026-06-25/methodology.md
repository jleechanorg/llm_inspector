# Methodology — PR #12 gzip re-issue + PR #10 mid-stream fix

## Environment

- OS: macOS Darwin 24.5.0
- Runtime: Node.js v20 (via CI), v22 (via CI and local)
- Vitest 4.1.6
- Repository: /Users/jleechan/projects_other/llm_inspector
- Branch (pre-merge): fix/re-issue-with-full-schema-gzip
- Base: main @ 3911bb1
- Head (pre-merge): 8c2d6a06
- Merge SHA: 3abf57cc1d2e9660c46d75807bf6359b35b4fecd

## Test #1 — gzip re-issue decompression

Setup: mock upstream returns content-encoding: gzip on the re-issued
request. The proxy must decompress before the client receives the response.

Procedure:
1. Mock upstream receives the re-issue POST (with full schemas).
2. Mock upstream responds with content-type: text/event-stream,
   content-encoding: gzip, body = gzipSync(plain UTF-8 SSE).
3. Proxy's reIssueWithFullSchema receives the gzipped response.
4. Pre-fix: `Buffer.concat(chunks).toString("utf-8")` returns mojibake.
5. Post-fix: `bodySource = createGunzip()` pipes through, decodes as utf-8.
6. Plain text "re-issued success" reaches the client.
7. Test asserts `expect(text).toContain("re-issued success")` and
   `expect(text).not.toContain("�")` (replacement char = mojibake marker).

## Test #2 — mid-stream upstream error (PR #10 regression)

Setup: mock upstream streams partial bytes then destroys the connection,
emitting 'error' on the proxy's response stream. The proxy must not crash
with "Cannot set headers after they are sent".

Procedure:
1. Dedicated mock upstream (port 29999) writes "data: chunk1\n\n" then
   schedules `res.destroy(new Error("upstream gone"))` after 10ms.
2. Proxy is started in observe mode on port 20005, pointing at the error
   upstream.
3. Client (Node fetch) POSTs to the proxy.
4. Pre-PR #10: proxy's gunzip/proxyRes error handler tried
   `res.writeHead(502, ...)` after `res.write(...)` had flushed headers,
   triggering "Cannot set headers after they are sent" uncaughtException.
5. Post-PR #10: the `if (!res.headersSent)` guard routes to `res.end()`
   instead. Proxy survives.
6. Test installs a `process.on("uncaughtException")` listener tagged with
   "Cannot set headers" and asserts it never fires.

## Test #3 — SHA-256 replay oracle (closes /es C6 gap)

Setup: a frozen, distinctive request payload is sent to the proxy. SHA-256
of the bytes the test client sent, the bytes mock upstream received, and
the bytes stored in the capture file's `request_raw` field must all match.
If any future change to `src/proxy.ts` silently mutates the request body,
the SHA-256 digests will diverge and this test will fail.

Procedure:
1. Frozen payload: `{"model":"claude-3-5-sonnet","tools":[{"name":"Bash","description":"shell tool"}],"messages":[{"role":"user","content":"oracle-test-payload-2026-06-25"}]}`
2. Frozen SHA-256: `92bc7bd1726eefb2a3bbcfb22e76e95660cde87d17a5bfdd2976678865f78a6e`
3. Proxy started in observe mode on port 20006, pointing at mock upstream on 19998.
4. Test client (Node fetch) POSTs the frozen payload.
5. Mock upstream records the bytes received in `upstreamRequests[0].body`.
6. Capture file is written to `.test-captures/oracle-run/<timestamp>.json`.
7. Test extracts `request_raw` (format: `<headers>\r\n\r\nBODY_BASE64:<b64>`),
   base64-decodes the body, computes SHA-256.
8. Three SHA-256 digests must all match.

## Side-by-side token savings

Setup: `scripts/test-side-by-side.mjs` creates two proxy instances
(observe mode and `lean,on-demand` mode) pointing at a mock Anthropic-shaped
upstream. Sends an identical Claude-shaped request with three heavy tools
through each, asserts:
- Total payload reduction >= 15% (measured: 86.2%)
- Tool definitions reduction >= 8% (measured: 86.5%)
- Stream chunks delivered exactly once (no duplicate chunks)
- On-demand re-issue successfully fetches full tool schema when stubbed tools triggered

## CI verification

PR #12 CI workflow run results (from GitHub check-runs on head 8c2d6a06):
- build-and-test (Node 20): success
- build-and-test (Node 22): success
- Cursor Bugbot: neutral

## Reproduction

```bash
cd /Users/jleechan/projects_other/llm_inspector
git checkout 3abf57cc1d2e9660c46d75807bf6359b35b4fecd   # post-merge
npm ci
npm test
# Expected: 125/125 pass, ~430ms
npm run test:side-by-side
# Expected: PASS — 86.2% payload reduction
```
