#!/bin/bash
set -euo pipefail

echo "Installing easyproxy..."

if ! command -v node &>/dev/null; then
  echo "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "npm is required to install the published easyproxy package." >&2
  exit 1
fi

echo "Using Node $(node --version)"

# Install easyproxy globally. npm 12 blocks dependency lifecycle scripts by default, and
# bun's postinstall is what unpacks the bundled runtime; without this approval the install
# succeeds but `epx` cannot start (#8361). npm 8 through 11 accept the flag on global installs.
# (keep sudo if the original install used sudo)
npm install -g --allow-scripts=bun easyproxy

if ! command -v epx &>/dev/null; then
  NPM_BIN="$(npm bin -g 2>/dev/null || printf "%s/bin" "$(npm prefix -g)")"
  echo "easyproxy installed, but 'epx' is not on PATH." >&2
  echo "Add your npm global bin directory to PATH, then rerun your shell: $NPM_BIN" >&2
  exit 1
fi

if ! epx help >/dev/null; then
  echo "easyproxy installed, but 'epx help' failed. Check your npm global install and PATH." >&2
  exit 1
fi

echo ""
echo "✅ easyproxy installed! Run 'epx init' to set up."
