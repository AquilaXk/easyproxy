#!/usr/bin/env bash
# Run only on a Linux packaging runner, against the completed .deb bundle.
# Usage: verify-linux-deb.sh [deb-bundle-dir-or-file]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
target="${1:-$root/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb}"
original="$root/desktop/src-tauri/binaries/epx-x86_64-unknown-linux-gnu"

if [ -f "$target" ]; then
  package="$target"
elif [ -d "$target" ]; then
  shopt -s nullglob
  packages=("$target"/*.deb)
  if [ "${#packages[@]}" -ne 1 ]; then
    echo "Expected exactly one completed .deb in $target, found ${#packages[@]}" >&2
    exit 1
  fi
  package="${packages[0]}"
else
  echo ".deb target does not exist: $target" >&2
  exit 1
fi
package="$(cd "$(dirname "$package")" && pwd)/$(basename "$package")"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
dpkg-deb -x "$package" "$scratch/pkg"

sidecar="$scratch/pkg/usr/bin/epx"
keyring="$scratch/pkg/usr/lib/EasyProxy/keyring/keyring.linux-x64-gnu.node"
native_bin_dir="$scratch/pkg/usr/lib/EasyProxy/native-bin/linux-x64"

test ! -L "$sidecar"
test -f "$sidecar"
test -x "$sidecar"
test -f "$keyring"
test ! -L "$native_bin_dir/epx-child"
test -f "$native_bin_dir/epx-child"
test -x "$native_bin_dir/epx-child"
test -f "$native_bin_dir/SHA256SUMS"
(cd "$native_bin_dir" && sha256sum -c SHA256SUMS)
cmp "$original" "$sidecar"
sha256sum "$original" "$sidecar"

desktop_hosts=0
for candidate in "$scratch/pkg/usr/bin/"*; do
  if [ "$(basename "$candidate")" != "epx" ] && [ -x "$candidate" ]; then
    desktop_hosts=$((desktop_hosts + 1))
  fi
done
if [ "$desktop_hosts" -lt 1 ]; then
  echo "Expected a desktop host executable in .deb usr/bin beside epx" >&2
  exit 1
fi

mkdir "$scratch/home"
(
  cd "$scratch"
  timeout 30s env EASYPROXY_HOME="$scratch/home" "$sidecar" --version
  timeout 15s env HOME="$scratch/home" EASYPROXY_HOME="$scratch/home/easyproxy" \
    "$sidecar" __keyring-load-check > "$scratch/keyring.json"
)
python3 - "$scratch/keyring.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value == {"schema": "epx-keyring-load/1", "available": True}, "Packaged .deb keyring binding is unavailable"
PY
