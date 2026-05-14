#!/usr/bin/env bash
# llm-inspector-install.sh — Install llm-inspector with launchd auto-start
#
# This script:
#   1. Installs ccproxy-api (Python OAuth proxy)
#   2. Installs llm-inspector (Node.js capture proxy)
#   3. Creates the launchd plist for auto-start on login
#   4. Loads the launchd agent

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
PLIST_SRC="$SCRIPT_DIR/com.jleechan.llm-inspector.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.jleechan.llm-inspector.plist"
LLM_INSPECTOR_DIR="$HOME/.llm-inspector"

# ── Detect Node.js path ────────────────────────────────────────────────────────
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

# ── 1. Install ccproxy-api (Python) ───────────────────────────────────────────
info "Checking ccproxy-api..."
if command -v ccproxy &>/dev/null; then
    info "ccproxy already installed"
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

# ── 3. Create launchd plist ───────────────────────────────────────────────────
info "Creating launchd agent..."
mkdir -p "$(dirname "$PLIST_DST")"
mkdir -p "$LLM_INSPECTOR_DIR"

NODE_PATH=$(detect_node)
cat > "$PLIST_DST" << EOF
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
        <key>LLM_INSPECTOR_UPSTREAM</key>
        <string>http://127.0.0.1:8001</string>
        <key>LLM_INSPECTOR_TOOL_MODE</key>
        <string>observe</string>
    </dict>
</dict>
</plist>
EOF
info "Plist written to $PLIST_DST"

# ── 4. Load launchd agent ────────────────────────────────────────────────────
info "Loading launchd agent..."
if launchctl load "$PLIST_DST" 2>/dev/null; then
    info "launchd agent loaded (will auto-start on login)."
else
    warn "Could not load launchd agent. Run manually:"
    warn "  launchctl load $PLIST_DST"
fi

# ── 5. Configure ccproxy ──────────────────────────────────────────────────────
CCPROXY_CONFIG="$HOME/.ccproxy/config.yaml"
if [ ! -f "$CCPROXY_CONFIG" ]; then
    info "Setting up ccproxy config..."
    mkdir -p "$HOME/.ccproxy"
    cat > "$CCPROXY_CONFIG" <<'EOF'
model_list:
  - model_name: default
    litellm_params:
      model: anthropic/claude-sonnet-4-5-20250929
      api_base: https://api.anthropic.com
      api_key: claude-api
EOF
    info "Created $CCPROXY_CONFIG"
fi

# ── 6. Authenticate ccproxy ──────────────────────────────────────────────────
info "Authenticating ccproxy with Claude OAuth..."
if ccproxy auth refresh claude-api 2>/dev/null; then
    info "OAuth token refreshed."
else
    warn "OAuth refresh failed — run manually: ccproxy auth login"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "Installation complete!"
echo ""
echo "To capture Claude Code traffic, add to your shell profile (~/.zshrc):"
echo "  export ANTHROPIC_BASE_URL=http://localhost:9000"
echo "  export ANTHROPIC_API_KEY=oauth-proxy"
echo ""
echo "The proxy auto-starts on login via launchd."
echo "To start immediately: launchctl start com.jleechan.llm-inspector"
echo ""
echo "Status: launchctl list | grep llm-inspector"