#!/usr/bin/env bash
# apply.sh — Apply all .patch files in this directory to the ccproxy-api venv.
#
# Idempotent: re-running on a venv that already has all patches is a no-op.
#
# Usage:
#   bash apply.sh                       # apply all patches
#   bash apply.sh --dry-run             # show what would change, don't apply
#   bash apply.sh --restart             # apply + launchctl kickstart ccproxy (default in install.sh)
#
# This script is called by scripts/llm-inspector-install.sh after every
# `uv tool install` (or upgrade) of ccproxy-api.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
RESTART=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --restart) RESTART=true ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()  { echo -e "${GREEN}[ccproxy-patches]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ccproxy-patches]${NC} $*"; }
error() { echo -e "${RED}[ccproxy-patches]${NC} $*" >&2; }

# ── Locate ccproxy venv ───────────────────────────────────────────────────────
CCPROXY_PY="$HOME/.local/share/uv/tools/ccproxy-api/bin/python"
if [ ! -x "$CCPROXY_PY" ]; then
  # Fall back to wherever ccproxy lives in PATH
  CCPROXY_BIN="$(command -v ccproxy 2>/dev/null || echo "")"
  if [ -z "$CCPROXY_BIN" ]; then
    error "ccproxy not found. Install with: uv tool install ccproxy-api"
    exit 1
  fi
  # ccproxy is a symlink to <venv>/bin/ccproxy
  CCPROXY_PY="$(readlink -f "$CCPROXY_BIN" 2>/dev/null || echo "$CCPROXY_BIN")"
fi

# Resolve site-packages directory (ccproxy is a namespace package — __file__ is None,
# so use __path__[0] instead). Patch paths are relative to the parent of ccproxy/,
# which is site-packages, because the patch files use paths like
# "ccproxy/llms/models/anthropic.py" (with the leading ccproxy/).
CCPROXY_PKG_DIR="$($CCPROXY_PY -c 'import ccproxy; print(ccproxy.__path__[0])' 2>/dev/null)"
if [ -z "$CCPROXY_PKG_DIR" ] || [ ! -d "$CCPROXY_PKG_DIR" ]; then
  error "Could not resolve ccproxy package dir from $CCPROXY_PY"
  exit 1
fi

# patch -d directory = parent of the ccproxy package (i.e. site-packages)
PATCH_D_DIR="$(dirname "$CCPROXY_PKG_DIR")"
info "ccproxy venv: $CCPROXY_PKG_DIR (patch base: $PATCH_D_DIR)"
echo

# ── Apply patches in numerical order ──────────────────────────────────────────
APPLIED=0
SKIPPED=0
FAILED=0

for patch_file in "$SCRIPT_DIR"/*.patch; do
  [ -e "$patch_file" ] || continue
  name="$(basename "$patch_file")"
  echo "── $name ──"

  # Detect already-applied by checking for the "## applied-marker:" line.
  # Each .patch file should have a header comment "## applied-marker: <unique-string>"
  # and the patch itself should add that string to the target file (as a comment).
  # This handles the case where patch -p1 dry-run returns 0 even when the patch is
  # already applied (patch is permissive about idempotent re-application).
  marker="$(grep -m1 '^## applied-marker:' "$patch_file" 2>/dev/null | sed 's/^## applied-marker:[[:space:]]*//')"
  if [ -n "$marker" ]; then
    target_file="$PATCH_D_DIR/$(grep -m1 '^+++ ' "$patch_file" | sed 's|^+++ b/||')"
    if [ -f "$target_file" ] && grep -qF "$marker" "$target_file"; then
      info "  already applied (marker found) — skipping"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  # --dry-run check: does patch apply cleanly?
  if patch -p1 -d "$PATCH_D_DIR" --dry-run < "$patch_file" >/dev/null 2>&1; then
    if $DRY_RUN; then
      info "  would apply (clean)"
    else
      # Real apply. (Don't pipe yes y; < $patch_file is the stdin for patch and overrides
      # any pipe. Idempotency is handled by the marker check above.)
      if patch -p1 -d "$PATCH_D_DIR" < "$patch_file" >/dev/null 2>&1; then
        info "  applied"
        APPLIED=$((APPLIED + 1))
      else
        error "  failed to apply (patch reported success on dry-run but failed here?)"
        FAILED=$((FAILED + 1))
      fi
    fi
  else
    # Dry-run failed. Two reasons: (a) already applied, (b) real conflict.
    # Distinguish via the marker check (already done above) — if no marker,
    # this is a real conflict.
    if [ -n "$marker" ]; then
      # Marker check above should have caught this; if we're here the marker
      # wasn't in the file but the patch also doesn't apply. Fall through.
      :
    fi
    error "  patch does not apply — manual conflict resolution needed"
    FAILED=$((FAILED + 1))
  fi
done

echo
info "Summary: applied=$APPLIED skipped=$SKIPPED failed=$FAILED"

# ── Clear pycache so the patched modules reload ───────────────────────────────
if [ "$APPLIED" -gt 0 ] && ! $DRY_RUN; then
  info "Clearing pycache..."
  find "$CCPROXY_PKG_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
fi

# ── Optionally restart ccproxy ────────────────────────────────────────────────
if $RESTART && [ "$APPLIED" -gt 0 ] && ! $DRY_RUN; then
  info "Restarting ccproxy via launchd kickstart -k..."
  launchctl kickstart -k "gui/$(id -u)/com.jleechan.ccproxy-api" 2>&1 | head -3
fi

# ── Exit code reflects success ────────────────────────────────────────────────
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
