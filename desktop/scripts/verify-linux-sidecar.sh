#!/usr/bin/env bash
# Run only on a Linux packaging runner, against the completed AppImage.
# Usage: verify-linux-sidecar.sh [appimage-bundle-dir-or-file]
# The release workflow builds each Linux format in its own Cargo target and stages the AppImage
# into an isolated directory, which it passes here; a local build keeps the default.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
target="${1:-$root/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage}"
original="$root/desktop/src-tauri/binaries/epx-x86_64-unknown-linux-gnu"
if [ -f "$target" ]; then
  image="$target"
elif [ -d "$target" ]; then
  shopt -s nullglob
  images=("$target"/*.AppImage)
  if [ "${#images[@]}" -ne 1 ]; then
    echo "Expected exactly one completed AppImage in $target, found ${#images[@]}" >&2
    exit 1
  fi
  image="${images[0]}"
else
  echo "AppImage target does not exist: $target" >&2
  exit 1
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
"$image" --appimage-extract > /dev/null
sidecar="$scratch/squashfs-root/usr/bin/epx"
keyring="$scratch/squashfs-root/usr/lib/EasyProxy/keyring/keyring.linux-x64-gnu.node"
native_bin_dir="$scratch/squashfs-root/usr/lib/EasyProxy/native-bin/linux-x64"
test ! -L "$sidecar"
test -f "$keyring"
test ! -L "$native_bin_dir/epx-child"
test -f "$native_bin_dir/epx-child"
test -x "$native_bin_dir/epx-child"
test -f "$native_bin_dir/SHA256SUMS"
(cd "$native_bin_dir" && sha256sum -c SHA256SUMS)
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
