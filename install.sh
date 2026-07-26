#!/usr/bin/env bash
# ceg-brain one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/CultureTek-Dev/ceg-brain/main/install.sh | bash
#
# What it does:
#   1. Installs Node 20+ (if missing) and pm2.
#   2. Clones/updates ceg-brain into ~/ceg-brain.
#   3. Creates .env from .env.example (generates app keys if you let it).
#   4. Checks for the subscription token (CLAUDE_CODE_OAUTH_TOKEN) — the ONE manual step:
#      run `claude setup-token` on a machine with a browser and paste it into .env.
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

# The default subscription path needs NO CLI on the VPS — it reads the
# CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) straight from .env. The `ant` CLI
# is only for the legacy fallback (BRAIN_BACKEND=subscription with no token set);
# it is not installed by default. Grab it from
# https://github.com/anthropics/anthropic-cli/releases if you specifically want it.

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
OAUTH_TOKEN="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' .env | cut -d= -f2- | tr -d ' ')"
if [ "$BACKEND" = "subscription" ] && [ -z "$OAUTH_TOKEN" ]; then
  if command -v ant >/dev/null && ant auth print-credentials --access-token >/dev/null 2>&1; then
    say "No CLAUDE_CODE_OAUTH_TOKEN, but the \`ant\` CLI is authed — using the legacy fallback ✅"
  else
    say "──────────────────────────────────────────────────────────────"
    say "ACTION NEEDED: set your Claude subscription token."
    say "On a machine WITH a browser, run:   claude setup-token"
    say "…copy the sk-ant-oat01-… value, then in $DIR/.env set:"
    say "    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…"
    say "Then re-run this installer."
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
