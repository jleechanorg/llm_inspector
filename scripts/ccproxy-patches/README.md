# ccproxy-api patches

This directory contains patches that we apply **on top of** ccproxy-api
(https://github.com/CaddyGlow/ccproxy-api) after every install or upgrade.

## Why

ccproxy-api has open bugs that affect the Claude Code → :9000 → :8000 → Anthropic
chain. Rather than wait for upstream fixes, we patch the installed venv in place.

**Patches here are durable across `uv tool install --upgrade ccproxy-api`** because
`scripts/llm-inspector-install.sh` re-runs `scripts/ccproxy-patches/apply.sh` at the
end of every install. Each install step also calls this apply script so any
`uv tool install --upgrade ccproxy-api` done manually gets the patches reapplied.

## How to add a patch

1. Create `<NNNN>-<short-description>.patch` with `diff -u` output
2. Add an entry to the table below
3. Test with `bash apply.sh` — it should be idempotent
4. Commit and push

## Patch table

| # | Patch | Upstream issue | Status |
|---|---|---|---|
| 0001 | `RequestContentBlock` includes `ThinkingBlock \| RedactedThinkingBlock` | https://github.com/CaddyGlow/ccproxy-api/issues/71 | Reported 2026-06-27, no upstream fix |

## How apply.sh works

```bash
# 1. Find the ccproxy venv (uv tool install puts it in ~/.local/share/uv/tools/ccproxy-api)
CCPROXY_PKG_DIR=$(/Users/jleechan/.local/share/uv/tools/ccproxy-api/bin/python -c \
  "import ccproxy, os; print(os.path.dirname(ccproxy.__file__))")

# 2. For each .patch file:
#    - Try patch -p1 --dry-run
#    - If "already applied" → skip
#    - Else patch -p1, then clear pycache

# 3. Restart ccproxy via launchctl kickstart -k (in install.sh, not here)
```

Patches are applied **in numerical order** so dependencies between patches are honored.
