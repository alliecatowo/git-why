#!/bin/sh
# Git Why installer.
#
#   curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
#
# POSIX sh. Installs the @alliecatowo/git-why npm package globally, then
# verifies that `git why` resolves through Git's subcommand dispatch.
#
# Environment variables:
#   GIT_WHY_VERSION   npm version/tag to install (default: latest)
#
# This script never invokes sudo on your behalf. If the active npm prefix
# is not writable, it explains your options and exits instead of escalating.

set -eu

PACKAGE="@alliecatowo/git-why"
VERSION="${GIT_WHY_VERSION:-latest}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

say() {
  printf '%s\n' "$1"
}

fail() {
  printf 'git-why: error: %s\n' "$1" >&2
  exit 1
}

# --- 1. OS / architecture -----------------------------------------------

os_name="$(uname -s 2>/dev/null || echo unknown)"
arch_name="$(uname -m 2>/dev/null || echo unknown)"

case "$os_name" in
  Darwin) giwhy_os=darwin ;;
  Linux) giwhy_os=linux ;;
  *)
    fail "unsupported operating system '$os_name'. Git Why supports macOS and Linux only (no Windows build is published; use WSL2)."
    ;;
esac

case "$arch_name" in
  arm64|aarch64) giwhy_arch=arm64 ;;
  x86_64|amd64) giwhy_arch=x64 ;;
  *)
    fail "unsupported architecture '$arch_name'. Git Why publishes arm64 and x64 builds only."
    ;;
esac

say "Detected platform: $giwhy_os/$giwhy_arch"

# --- 2. Prerequisites: git, node ------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  fail "git was not found on PATH. Install Git first: https://git-scm.com/downloads"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found on PATH. Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} first: https://nodejs.org/ (or via nvm/mise/volta)."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm was not found on PATH. It normally ships with Node.js; reinstall Node.js from https://nodejs.org/."
fi

node_version="$(node -v 2>/dev/null | sed 's/^v//')"
node_major="$(echo "$node_version" | cut -d. -f1)"
node_minor="$(echo "$node_version" | cut -d. -f2)"

node_ok=0
if [ "$node_major" -gt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  node_ok=1
elif [ "$node_major" -eq "$MIN_NODE_MAJOR" ] 2>/dev/null && [ "$node_minor" -ge "$MIN_NODE_MINOR" ] 2>/dev/null; then
  node_ok=1
fi

if [ "$node_ok" -ne 1 ]; then
  fail "node $node_version was found, but Git Why requires >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}. Upgrade Node.js (nvm, mise, volta, or https://nodejs.org/) and re-run this script."
fi

say "Found git: $(git --version)"
say "Found node: v$node_version"

# --- 3. Writable npm prefix, no silent sudo -------------------------------

npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"

if [ -z "$npm_prefix" ]; then
  fail "could not determine the npm global prefix (npm config get prefix). Fix your npm configuration and re-run."
fi

prefix_check_dir="$npm_prefix"
if [ ! -d "$prefix_check_dir" ]; then
  # npm creates the prefix lazily; check the nearest existing ancestor instead.
  prefix_check_dir="$(dirname "$npm_prefix")"
fi

if [ ! -w "$prefix_check_dir" ]; then
  say ""
  say "The npm global prefix ('$npm_prefix') is not writable by $(whoami)."
  say "This script will not silently re-run itself with sudo. Pick one:"
  say ""
  say "  1. Use a Node version manager (nvm, mise, volta, fnm) so your npm"
  say "     prefix lives in your home directory. Recommended."
  say "  2. Point npm at a writable prefix you own:"
  say "       npm config set prefix \"\$HOME/.local\""
  say "       export PATH=\"\$HOME/.local/bin:\$PATH\""
  say "  3. If you understand the risk, install with elevated privileges yourself:"
  say "       sudo npm install -g ${PACKAGE}@${VERSION}"
  say ""
  fail "npm prefix '$npm_prefix' is not writable."
fi

# --- 4. Install ------------------------------------------------------------

say ""
say "About to run: npm install -g ${PACKAGE}@${VERSION}"
say ""

npm install -g "${PACKAGE}@${VERSION}"

# --- 5. Verify ---------------------------------------------------------

if ! command -v git-why >/dev/null 2>&1; then
  fail "installed ${PACKAGE}, but the 'git-why' executable is not on PATH ($npm_prefix/bin). Add it to PATH and re-run 'git why -h'."
fi

installed_version="$(git-why --version 2>/dev/null || echo unknown)"

if git why -h >/dev/null 2>&1; then
  say ""
  say "Installed git-why ${installed_version}. 'git why' resolves correctly."
  say "Try it: git why \"why does this function exist\""
else
  fail "'git-why' is on PATH but 'git why -h' failed. Check that '$npm_prefix/bin' is on PATH before other 'why'-named commands, then re-run 'git why -h' yourself."
fi
