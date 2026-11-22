#!/usr/bin/env bash
# Run only on a Linux packaging runner, against the completed AppImage.
# Usage: verify-linux-sidecar.sh [appimage-bundle-dir]
# The release workflow builds each Linux format in its own Cargo target and stages the AppImage
# into an isolated read-only directory, which it passes here; a local build keeps the default.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
bundle="${1:-$root/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage}"
original="$root/desktop/src-tauri/binaries/epx-x86_64-unknown-linux-gnu"
shopt -s nullglob
images=("$bundle"/*.AppImage)
if [ "${#images[@]}" -ne 1 ]; then
  echo "Expected exactly one completed AppImage" >&2
  exit 1
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
"${images[0]}" --appimage-extract > /dev/null
sidecar="$scratch/squashfs-root/usr/bin/epx"
keyring="$scratch/squashfs-root/usr/lib/EasyProxy/keyring/keyring.linux-x64-gnu.node"
test ! -L "$sidecar"
test -f "$keyring"
cmp "$original" "$sidecar"
sha256sum "$original" "$sidecar"
mkdir "$scratch/home"
timeout 30s env EASYPROXY_HOME="$scratch/home" "$sidecar" --version
timeout 15s env HOME="$scratch/home" EASYPROXY_HOME="$scratch/home/easyproxy" \
  "$sidecar" __keyring-load-check > "$scratch/keyring.json"
python3 - "$scratch/keyring.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value == {"schema": "epx-keyring-load/1", "available": True}, "Packaged keyring binding is unavailable"
PY
