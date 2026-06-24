# Attractor Specification: Proxy Side-by-Side testing

## Convergence Target
To have a robust, automated validation pipeline that proves both the behavioral correctness and the exact token savings of the `llm-inspector` proxy optimizations on every PR, preventing regression of stream duplication, zlib decompression errors, and OOM issues.

---

## Observable Convergence Criteria

1. **Zero-Errors Output**: The test runner output prints clean, green checkmarks (`✅`) for both normal streaming and re-issue streaming.
2. **Deterministic Metric Assertions**:
   - Compares baseline request size vs optimized request size.
   - Asserts and prints: `[PASS] Turn payload reduction: X% (>= 15%)`.
   - Asserts and prints: `[PASS] Tool definition reduction: Y% (>= 8%)`.
3. **Automatic Clean Exit**: The script terminates all spawned processes (mock upstream, proxy worker) and exits with code `0`.
4. **No Captures Pollution**: The test writes captures to a temporary folder and deletes them upon completion, leaving the global user captures folder untouched.

---

## Anti-Attractor States (Failure Indicators)

1. **Zlib/Decompression Warnings**: Any output containing `ZlibError` or similar gzip/deflate decoding exceptions.
2. **Double Write / Stream Interruption**: Client receiving duplicated chunks or cut-off tool call JSON strings.
3. **OOM Crashes**: Memory footprint spikes causing node to crash during metadata/payload analysis.
4. **Port Conflicts**: Failure to start because ports `9000` or `9001` are busy, instead of using dedicated test ports `18889`/`18888`.
5. **Incomplete Cleanup**: Orphaned node background processes running after the test run finishes.
