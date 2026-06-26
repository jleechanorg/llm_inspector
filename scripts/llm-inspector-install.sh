#!/usr/bin/env bash
# llm-inspector-install.sh — Install llm-inspector + ccproxy-api with launchd auto-start
#
# This script:
#   1. Installs ccproxy-api (Python OAuth proxy) on port 8000
#   2. Installs llm-inspector (Node.js capture proxy) on port 9000
#   3. Creates launchd plists for BOTH so they auto-start on login
#   4. Loads both launchd agents
#   5. Verifies OAuth credentials for the claude_api provider
#
# Architecture after install:
#   Claude Code → llm-inspector :9000 (capture) → ccproxy-api :8000 (OAuth) → Anthropic

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[llm-inspector]${NC} $*"; }
warn()  { echo -e "${YELLOW}[llm-inspector]${NC} $*"; }
error() { echo -e "${RED}[llm-inspector]${NC} $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

LLM_INSPECTOR_PLIST_SRC="$SCRIPT_DIR/com.jleechan.llm-inspector.plist"
CCPROXY_PLIST_SRC="$SCRIPT_DIR/com.jleechan.ccproxy-api.plist"
LLM_INSPECTOR_PLIST_DST="$HOME/Library/LaunchAgents/com.jleechan.llm-inspector.plist"
CCPROXY_PLIST_DST="$HOME/Library/LaunchAgents/com.jleechan.ccproxy-api.plist"

LLM_INSPECTOR_DIR="$HOME/.llm-inspector"
CCPROXY_DIR="$HOME/.ccproxy"
CCPROXY_CONFIG="$CCPROXY_DIR/ccproxy.yaml"

# ── Detect Node.js path ───────────────────────────────────────────────────────
detect_node() {
    if [ -x "$HOME/.nvm/versions/node/v22.22.0/bin/node" ]; then
        echo "$HOME/.nvm/versions/node/v22.22.0/bin/node"
    elif command -v node &>/dev/null; then
        echo "$(command -v node)"
    else
        error "Node.js not found. Install Node.js 18+ first: https://nodejs.org"
        exit 1
    fi
}

# ── Detect ccproxy binary path (used by plist) ───────────────────────────────
detect_ccproxy() {
    if [ -x "$HOME/.local/bin/ccproxy" ]; then
        echo "$HOME/.local/bin/ccproxy"
    elif command -v ccproxy &>/dev/null; then
        echo "$(command -v ccproxy)"
    else
        echo "$HOME/.local/bin/ccproxy"  # default post-install location
    fi
}

# ── 1. Install ccproxy-api (Python) ───────────────────────────────────────────
info "Checking ccproxy-api..."
if command -v ccproxy &>/dev/null; then
    info "ccproxy already installed at $(command -v ccproxy)"
else
    info "Installing ccproxy-api..."
    if command -v uv &>/dev/null; then
        uv tool install ccproxy-api
    elif command -v pip3 &>/dev/null; then
        pip3 install --user ccproxy-api
    elif command -v pip &>/dev/null; then
        pip install --user ccproxy-api
    else
        error "Neither uv nor pip found. Install Python first: https://docs.astral.sh/uv/getting-started/installation/"
        exit 1
    fi

    if command -v ccproxy &>/dev/null; then
        info "ccproxy-api installed."
    else
        warn "ccproxy not in PATH — you may need: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
fi

# ── 2. Build llm-inspector ─────────────────────────────────────────────────────
info "Building llm-inspector..."
if [ ! -f "$REPO_DIR/package.json" ]; then
    error "llm-inspector repo not found at $REPO_DIR"
    exit 1
fi

cd "$REPO_DIR"
if command -v npm &>/dev/null; then
    npm install
    npm run build
    info "llm-inspector built."
else
    error "npm not found. Install Node.js 18+: https://nodejs.org"
    exit 1
fi

# ── 3. Create directories ────────────────────────────────────────────────────
mkdir -p "$LLM_INSPECTOR_DIR"
mkdir -p "$CCPROXY_DIR"
mkdir -p "$(dirname "$LLM_INSPECTOR_PLIST_DST")"

# ── 4. Write ccproxy config (only if missing) ─────────────────────────────────
info "Setting up ccproxy config at $CCPROXY_CONFIG..."
if [ ! -f "$CCPROXY_CONFIG" ]; then
    cat > "$CCPROXY_CONFIG" <<'EOF'
ccproxy:
  debug: true
  handler: "ccproxy.handler:CCProxyHandler"

  oat_sources:
    anthropic: "jq -r '.claudeAiOauth.accessToken' ~/.claude/.credentials.json"

  hooks:
    - ccproxy.hooks.rule_evaluator
    - ccproxy.hooks.model_router
    - ccproxy.hooks.capture_headers
    - ccproxy.hooks.forward_oauth

  default_model_passthrough: true
  rules: []

litellm:
  host: 127.0.0.1
  port: 4000
  num_workers: 4
  debug: true
EOF
    info "Created $CCPROXY_CONFIG"
else
    info "ccproxy config already exists at $CCPROXY_CONFIG (not overwriting)"
fi

# ── 5. Create launchd plists ────────────────────────────────────────────────
info "Writing launchd plists..."

NODE_PATH=$(detect_node)
CCPROXY_PATH=$(detect_ccproxy)

# 5a. llm-inspector proxy on :9000 (forwards to ccproxy on :8000)
cat > "$LLM_INSPECTOR_PLIST_DST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jleechan.llm-inspector</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$REPO_DIR/dist/cli.js</string>
        <string>_proxy-worker</string>
        <string>--port</string>
        <string>9000</string>
        <string>--tool-mode</string>
        <string>observe</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LLM_INSPECTOR_DIR/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$LLM_INSPECTOR_DIR/launchd.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- Forward to ccproxy-api on port 8000 (its default). -->
        <key>LLM_INSPECTOR_UPSTREAM</key>
        <string>http://127.0.0.1:8000</string>
        <key>LLM_INSPECTOR_TOOL_MODE</key>
        <string>observe</string>
    </dict>
</dict>
</plist>
EOF
info "  → $LLM_INSPECTOR_PLIST_DST"

# 5b. ccproxy-api on :8000 (OAuth → Anthropic)
cat > "$CCPROXY_PLIST_DST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jleechan.ccproxy-api</string>
    <key>ProgramArguments</key>
    <array>
        <string>$CCPROXY_PATH</string>
        <string>serve</string>
        <string>--port</string>
        <string>8000</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LLM_INSPECTOR_DIR/ccproxy.log</string>
    <key>StandardErrorPath</key>
    <string>$LLM_INSPECTOR_DIR/ccproxy.err.log</string>
    <!-- launchd PATH is minimal; ensure ccproxy's Python venv is reachable -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
info "  → $CCPROXY_PLIST_DST"

# ── 6. Load launchd agents ──────────────────────────────────────────────────
info "Loading launchd agents..."
for plist in "$LLM_INSPECTOR_PLIST_DST" "$CCPROXY_PLIST_DST"; do
    label=$(basename "$plist" .plist)
    # Unload first in case it's already loaded (idempotent re-install)
    launchctl unload "$plist" 2>/dev/null || true
    if launchctl load "$plist" 2>/dev/null; then
        info "  → $label loaded"
    else
        warn "  → could not load $label. Run: launchctl load $plist"
    fi
done

# ── 7. Verify OAuth credentials ─────────────────────────────────────────────
info "Checking ccproxy OAuth credentials..."
if command -v ccproxy &>/dev/null; then
    # The provider name is `claude_api` in ccproxy-api (not `claude-api`).
    # `ccproxy auth status` exits non-zero if not logged in.
    if ccproxy auth status claude_api >/dev/null 2>&1; then
        info "OAuth credentials present for claude_api provider"
    else
        warn "Not logged in to claude_api — run: ccproxy auth login claude_api"
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "Installation complete!"
echo ""
echo "Architecture:"
echo "  Claude Code → llm-inspector :9000 (capture) → ccproxy-api :8000 (OAuth) → Anthropic"
echo ""
echo "To capture Claude Code traffic, add to your shell profile (~/.zshrc or ~/.bashrc):"
echo "  export ANTHROPIC_BASE_URL=http://localhost:9000"
echo "  export ANTHROPIC_API_KEY=oauth-proxy"
echo ""
echo "Both proxies auto-start on login via launchd (KeepAlive=true)."
echo "To start immediately:"
echo "  launchctl start com.jleechan.ccproxy-api    # OAuth proxy first"
echo "  launchctl start com.jleechan.llm-inspector  # capture proxy second"
echo ""
echo "Or use the cli (handles ordering automatically):"
echo "  cd $REPO_DIR && node dist/cli.js start"
echo ""
echo "Status: launchctl list | grep -E 'llm-inspector|ccproxy-api'"
echo "Logs:   $LLM_INSPECTOR_DIR/{launchd,ccproxy}.log"