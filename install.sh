#!/usr/bin/env bash
# ceg-brain one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/CultureTek-Dev/ceg-brain/main/install.sh | bash
#
# What it does:
#   1. Installs Node 20+ (if missing), the `ant` CLI, and pm2.
#   2. Clones/updates ceg-brain into ~/ceg-brain.
#   3. Creates .env from .env.example (generates app keys if you let it).
#   4. Prompts you to run `ant auth login` (subscription) — the ONE manual step.
#   5. Builds and starts the brain under pm2.
set -euo pipefail

REPO="${CEG_BRAIN_REPO:-https://github.com/CultureTek-Dev/ceg-brain.git}"
DIR="${CEG_BRAIN_DIR:-$HOME/ceg-brain}"
BRANCH="${CEG_BRAIN_BRANCH:-main}"

say() { printf '\033[1;36m[ceg-brain]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ceg-brain] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Prereqs -------------------------------------------------------------
command -v git >/dev/null || die "git is required"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  say "Installing Node 20 (via nvm)…"
  export NVM_DIR="$HOME/.nvm"
  [ -d "$NVM_DIR" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 20 >/dev/null
  nvm alias default 20 >/dev/null
fi
command -v pm2 >/dev/null || { say "Installing pm2…"; npm install -g pm2 >/dev/null; }

# The `ant` CLI is only needed for BRAIN_BACKEND=subscription (which uses the
# Anthropic *API plane* via OAuth — this bills API usage, NOT a Pro/Max
# subscription; genuine subscription reuse needs Claude Code, see README).
# For BRAIN_BACKEND=api you don't need `ant` at all.
if ! command -v ant >/dev/null; then
  say "Fetching the Anthropic CLI (\`ant\`)…  (skip with BRAIN_BACKEND=api)"
  VER="$(curl -fsSL https://api.github.com/repos/anthropics/anthropic-cli/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  OS="$(uname -s | tr A-Z a-z)"; ARCH="$(uname -m | sed -e s/x86_64/amd64/ -e s/aarch64/arm64/)"
  if [ -n "$VER" ] && curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/${VER}/ant_${VER#v}_${OS}_${ARCH}.tar.gz" | tar -xz -C /usr/local/bin ant 2>/dev/null; then
    say "Installed ant ${VER}"
  elif command -v go >/dev/null; then
    go install github.com/anthropics/anthropic-cli/cmd/ant@latest && export PATH="$PATH:$(go env GOPATH)/bin"
  else
    say "Couldn't auto-install \`ant\`. NOTE: this is NOT \`apt install ant\` (that's Apache Ant)."
    say "Either grab it from https://github.com/anthropics/anthropic-cli/releases,"
    say "or — simpler — use the API backend: set BRAIN_BACKEND=api + ANTHROPIC_API_KEY in .env, then re-run."
  fi
fi

# --- 2. Clone / update ------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR…"; git -C "$DIR" fetch -q && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q
else
  say "Cloning into $DIR…"; git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

# --- 3. .env ----------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  KEY1="sk-ceg-$(openssl rand -hex 20)"
  KEY2="sk-ceg-$(openssl rand -hex 20)"
  # Portable in-place edit
  sed -i.bak "s|^BRAIN_KEYS=.*|BRAIN_KEYS=slack:$KEY1,onboarding:$KEY2|" .env && rm -f .env.bak
  say "Generated .env with two app keys. Add more in BRAIN_KEYS as needed."
  say "  slack       key: $KEY1"
  say "  onboarding  key: $KEY2"
else
  say ".env already exists — leaving it untouched."
fi
chmod 600 .env

# --- 4. Auth (the one manual step) -----------------------------------------
BACKEND="$(grep -E '^BRAIN_BACKEND=' .env | cut -d= -f2 | tr -d ' ')"
if [ "$BACKEND" = "subscription" ]; then
  if ant auth print-credentials --access-token >/dev/null 2>&1; then
    say "Claude subscription already authed on this box ✅"
  else
    say "──────────────────────────────────────────────────────────────"
    say "ACTION NEEDED: authenticate this box to your Claude subscription."
    say "Run:   ant auth login --no-browser"
    say "…open the printed URL, approve, paste the code back. Then re-run this installer."
    say "──────────────────────────────────────────────────────────────"
    exit 0
  fi
fi

# --- 5. Build + start -------------------------------------------------------
say "Installing deps…"; npm install --no-audit --no-fund >/dev/null
say "Building…"; npm run build >/dev/null
say "Starting under pm2…"
pm2 start ecosystem.config.cjs >/dev/null || pm2 restart ceg-brain >/dev/null
pm2 save >/dev/null || true

PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' ')"
say "Up ✅  Local: http://127.0.0.1:${PORT:-8787}   Health: curl -s http://127.0.0.1:${PORT:-8787}/health"
say "Front it with your reverse proxy (Coolify/Traefik/Caddy) to get a public HTTPS base URL."
say "Point apps' OpenAI SDK at  <public-base-url>/v1  with one of the app keys above."
