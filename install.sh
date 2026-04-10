#!/usr/bin/env bash
# install.sh — Install llm-inspector and ccproxy-api
#
# llm-inspector needs two components:
#   1. ccproxy-api  — Python OAuth proxy (handles Anthropic/Claude auth)
#   2. llm-inspector — Node.js capture proxy + analyzer (this package)
#
# The capture chain is:
#   Your tool → llm-inspector :9000 (captures payloads) → ccproxy :8000 (OAuth) → Anthropic API

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[llm-inspector]${NC} $*"; }
warn()    { echo -e "${YELLOW}[llm-inspector]${NC} $*"; }
error()   { echo -e "${RED}[llm-inspector]${NC} $*" >&2; }

# ── 1. Install ccproxy-api (Python, via uv or pip) ───────────────────────────

info "Installing ccproxy-api..."

if command -v uv &>/dev/null; then
  uv tool install ccproxy-api
  info "ccproxy-api installed via uv"
elif command -v pip3 &>/dev/null; then
  pip3 install --user ccproxy-api
  info "ccproxy-api installed via pip3"
elif command -v pip &>/dev/null; then
  pip install --user ccproxy-api
  info "ccproxy-api installed via pip"
else
  error "Neither uv nor pip found. Install Python first: https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
fi

# Verify ccproxy is in PATH
if ! command -v ccproxy &>/dev/null; then
  warn "ccproxy not found in PATH after install."
  warn "You may need to add uv/pip bin dir to your PATH:"
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  warn "Then re-run this script."
fi

# ── 2. Install llm-inspector (Node.js, via npm) ───────────────────────────────

info "Installing llm-inspector..."

if ! command -v node &>/dev/null; then
  error "Node.js not found. Install Node.js 18+ first: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 18+ required (found v$(node --version))"
  exit 1
fi

if command -v npm &>/dev/null; then
  npm install -g llm-inspector
  info "llm-inspector installed via npm"
else
  error "npm not found. Install Node.js 18+: https://nodejs.org"
  exit 1
fi

# ── 3. Configure ccproxy ──────────────────────────────────────────────────────

CCPROXY_CONFIG="$HOME/.ccproxy/config.yaml"
if [ ! -f "$CCPROXY_CONFIG" ]; then
  info "Setting up ccproxy config at $CCPROXY_CONFIG..."
  mkdir -p "$HOME/.ccproxy"
  cat > "$CCPROXY_CONFIG" <<'EOF'
model_list:
  - model_name: default
    litellm_params:
      model: anthropic/claude-sonnet-4-5-20250929
      api_base: https://api.anthropic.com
      api_key: claude-api
EOF
  info "Created $CCPROXY_CONFIG — edit to set your model or API key"
else
  info "ccproxy config already exists at $CCPROXY_CONFIG"
fi

# ── 4. Authenticate ccproxy ───────────────────────────────────────────────────

info "Authenticating ccproxy with Claude OAuth..."
info "(If you have an API key instead, edit $CCPROXY_CONFIG and set api_key: env/ANTHROPIC_API_KEY)"
echo ""

if ccproxy auth refresh claude-api 2>/dev/null; then
  info "ccproxy OAuth token refreshed."
else
  warn "ccproxy auth refresh failed — you may need to authenticate manually:"
  warn "  ccproxy auth login"
fi

# ── 5. Done ───────────────────────────────────────────────────────────────────

echo ""
info "Installation complete!"
echo ""
echo "Quick start:"
echo "  llm-inspector start                            # starts capture chain"
echo "  export ANTHROPIC_BASE_URL=http://localhost:9000"
echo "  claude --print 'What is 2+2?'                 # make a request"
echo "  llm-inspector analyze                          # see token breakdown"
echo ""
echo "To stop:"
echo "  llm-inspector stop"
