# Functional Specification: Proxy Side-by-Side testing

## Description
An automated, side-by-side test pipeline that executes a target set of LLM queries through `llm-inspector` in two configurations:
1. **Observer Mode (`observe`)**: Zero modifications, capturing raw Anthropic API payloads (representing the baseline).
2. **Optimized Mode (`lean,on-demand`)**: Active proxy optimization stripping unused/heavy tool schemas and lazy-loading them on-demand.

The pipeline compares the token/byte overhead of both runs to verify both behavior correctness and token savings quantitatively.

---

## Acceptance Criteria

1. **Automation**: Must be executable via a single command (e.g., `npm run test:side-by-side` or `node scripts/test-side-by-side.mjs`).
2. **Behavior Verification**:
   - Verify that client responses are functionally identical in both modes (no zlib errors, no duplicate streams, no missing tool outputs).
   - Both runs must exit successfully with `exit 0` from the client.
3. **Metric Assertions**:
   - Assert that **On-Demand + Lean** mode achieves a minimum of **15% turn size reduction** in input tokens/bytes.
   - Assert that **Tool Definitions** size is reduced by a minimum of **8%**.
4. **OOM Safety**:
   - Verify that the `analyze` command executes successfully on large capture sets without running out of memory.
5. **Port Isolation**:
   - The test must use dynamic or clean ports (e.g., `18889` for proxy, `18888` for mock upstream) to prevent conflicts with the user's running launchd proxies on ports `9000` and `9001`.

---

## Test Command
```bash
node scripts/test-side-by-side.mjs
```

---

## Non-Goals
* Testing direct user latency/network speed (which is network/provider-dependent).
* Testing multi-user concurrent loads.
* Modifying user profiles or active launchd settings.

---

## Lane-Independence Matrix

| Lane | Dependency | Isolation Strategy |
| :--- | :--- | :--- |
| **Mock Upstream** | TCP port `18888` | Spawns a local Node HTTP server listening strictly on localhost. |
| **Proxy Instance** | TCP port `18889` | Spawns proxy worker bound to the local mock upstream. |
| **Harness Runs** | Capture directory | Clears captures before each phase using an isolated temp folder `/tmp/llm-inspector-test-captures`. |
