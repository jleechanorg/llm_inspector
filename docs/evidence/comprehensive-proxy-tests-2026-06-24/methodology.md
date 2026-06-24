# Methodology

This evidence bundle verifies the correct operation of the `llm-inspector` proxy integration and advanced modes.

## Environment
- Node.js: >=18.0.0
- Test Framework: Vitest
- Local Mock Servers: Started dynamically on local ports `19998` (upstream) and `19999`+ (proxies)

## Commands Run
To run the integration tests:
```bash
npx vitest run src/proxy.test.ts
```

## Pass Criteria
- All 6 tests must pass cleanly.
- Proxy must correctly capture and save JSON request logs to the target directory.
- Upstream tools must be modified/stripped/re-issued correctly depending on the toolMode configured.
