# Evidence

## Claims & Verifications

- **Claim 1:** The proxy transparently routes streaming chunk requests and decompresses gzip-encoded chunks.
  - *Layer:* Layer 2 mock-at-network.
  - *Proof:* `src/proxy.test.ts` sends a request, verifies that headers are forwarded without `accept-encoding` to the mock upstream, and that uncompressed streaming content is successfully delivered to the client.
- **Claim 2:** The proxy correctly writes capture files and summary files to `LLM_INSPECTOR_CAPTURE_DIR`.
  - *Layer:* Layer 2 mock-at-network.
  - *Proof:* `src/proxy.test.ts` overrides the directory, executes a request, and asserts that a `.json` and `.summary.json` file are created with correct model names and size estimates.
- **Claim 3:** The proxy strips tools configured in the lean remove list.
  - *Layer:* Layer 2 mock-at-network.
  - *Proof:* `src/proxy.test.ts` configures `toolMode: "lean"`, sends a tool request with `mcp__claude-in-chrome__navigate`, and asserts that the mock upstream only receives the `Bash` tool.
- **Claim 4:** The proxy handles on-demand tool stubbing and dynamic re-issuing.
  - *Layer:* Layer 2 mock-at-network.
  - *Proof:* `src/proxy.test.ts` configures `toolMode: "on-demand"`, receives a tool use request from the upstream, intercepts it, and re-issues it containing the full schema, returning `re-issued success` to the client.
- **Claim 5:** The proxy patches `input_tokens: 0` to estimated token counts.
  - *Layer:* Layer 2 mock-at-network.
  - *Proof:* `src/proxy.test.ts` configures `toolMode: "wafer-fix"` and asserts that the client's output gets updated with a non-zero token estimation.

## Claim → Artifact Map

- **Claim 1:** Verified by test case `transparent routes streaming requests and outputs expected chunks` and `transparent decompresses gzip responses from upstream and passes uncompressed stream to client` in [src/proxy.test.ts](file:///Users/jleechan/projects_other/llm_inspector/src/proxy.test.ts#L104-L146).
- **Claim 2:** Verified by test case `saves capture JSON and summary JSON to LLM_INSPECTOR_CAPTURE_DIR` in [src/proxy.test.ts](file:///Users/jleechan/projects_other/llm_inspector/src/proxy.test.ts#L148-L203).
- **Claim 3:** Verified by test case `strips lean-remove tools in lean mode` in [src/proxy.test.ts](file:///Users/jleechan/projects_other/llm_inspector/src/proxy.test.ts#L205-L242).
- **Claim 4:** Verified by test case `stubs heavy tools in on-demand mode and handles re-issue dynamically` in [src/proxy.test.ts](file:///Users/jleechan/projects_other/llm_inspector/src/proxy.test.ts#L244-L298).
- **Claim 5:** Verified by test case `patches input_tokens:0 to estimated value in wafer-fix mode` in [src/proxy.test.ts](file:///Users/jleechan/projects_other/llm_inspector/src/proxy.test.ts#L300-L330).

## What This Evidence Does NOT Prove

- This evidence does not verify real Anthropic API endpoints as the tests utilize a localized mock upstream server for deterministic, offline testing.
- This evidence does not prove the performance or latency characteristics of the proxy under high network load.
