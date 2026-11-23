#!/usr/bin/env bash
set -euo pipefail

app_input="${1:?usage: verify-macos-runtime.sh /path/to/EasyProxy.app}"
app="$(cd "$(dirname "$app_input")" && pwd)/$(basename "$app_input")"
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS bundle verification requires macOS' >&2; exit 1; }
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
[[ -n "$executable" && "$executable" != */* ]] || { echo 'Invalid app executable name' >&2; exit 1; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/easyproxy-bundle-check.XXXXXX")"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

codesign --verify --strict --deep "$app"
app_sig_log="$scratch/app-root-signature.log"
codesign --display --verbose=4 "$app" > "$app_sig_log" 2>&1
team_id="$(python3 - "$app_sig_log" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r"^TeamIdentifier=([A-Z0-9]{10})$", text, re.MULTILINE)
print(m.group(1) if m else "")
PY
)"
verify_member() {
  local role="$1" member="$2"
  codesign --display --entitlements - --xml "$member" > "$scratch/$role.plist" 2> "$scratch/$role-entitlements.log"
  codesign --display --verbose=4 "$member" > "$scratch/$role-signature.log" 2>&1
  python3 - "$role" "$scratch/$role.plist" "$scratch/$role-signature.log" "$team_id" <<'PY'
import pathlib, plistlib, re, sys
role, entitlements, signature, team_id = sys.argv[1:]
actual = plistlib.loads(pathlib.Path(entitlements).read_bytes())
if team_id:
    app_group = f"{team_id}.com.easyproxy.desktop"
    if role == "widget":
        expected = {"com.apple.security.app-sandbox": True, "com.apple.security.application-groups": [app_group]}
        if actual != expected:
            raise SystemExit(f"Unexpected {role} entitlement dictionary: {actual!r}")
    elif role == "app":
        expected = {"com.apple.security.cs.allow-jit": True, "com.apple.security.application-groups": [app_group]}
        if actual != expected:
            raise SystemExit(f"Unexpected {role} entitlement dictionary: {actual!r}")
    elif role == "epx":
        if actual.get("com.apple.security.cs.allow-jit") is not True:
            raise SystemExit(f"Missing allow-jit entitlement on {role}")
        extra_keys = set(actual.keys()) - {"com.apple.security.cs.allow-jit", "com.apple.security.application-groups"}
        if extra_keys:
            raise SystemExit(f"Unexpected {role} entitlements: {sorted(extra_keys)}")
        if "com.apple.security.application-groups" in actual and actual["com.apple.security.application-groups"] != [app_group]:
            raise SystemExit(f"Unexpected {role} application-groups: {actual['com.apple.security.application-groups']!r}")
else:
    expected = {"com.apple.security.app-sandbox": True} if role == "widget" else {"com.apple.security.cs.allow-jit": True}
    if actual != expected:
        raise SystemExit(f"Unexpected {role} entitlement dictionary")
text = pathlib.Path(signature).read_text()
if not re.search(r"flags=.*\bruntime\b", text):
    raise SystemExit(f"Missing hardened runtime on {role}")
if team_id and not re.search(rf"^TeamIdentifier={re.escape(team_id)}$", text, re.MULTILINE):
    raise SystemExit(f"Missing TeamIdentifier={team_id} on {role}")
PY
}
verify_member app "$app"
verify_member epx "$app/Contents/MacOS/epx"
verify_member widget "$app/Contents/PlugIns/EasyProxyWidget.appex"
python3 - "$app" "$team_id" <<'PY'
import os, pathlib, plistlib, re, subprocess, sys

app_dir = pathlib.Path(sys.argv[1])
team_id = sys.argv[2]
MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}

def is_macho(path: pathlib.Path) -> bool:
    try:
        with path.open("rb") as fh:
            head = fh.read(8)
    except OSError:
        return False
    if len(head) < 4 or head[:4] not in MACHO_MAGICS:
        return False
    if head[:4] in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        if len(head) < 8:
            return False
        endian = "big" if head[:4] == b"\xca\xfe\xba\xbe" else "little"
        nfat = int.from_bytes(head[4:8], endian)
        return 1 <= nfat <= 16
    return True

machos = []
for root, _, files in os.walk(app_dir):
    for name in sorted(files):
        candidate = pathlib.Path(root) / name
        if candidate.is_symlink() or not candidate.is_file():
            continue
        if is_macho(candidate):
            machos.append(candidate)

if not machos:
    raise SystemExit("No Mach-O binaries found inside app bundle")

keyring_addons = list((app_dir / "Contents" / "Resources" / "keyring").glob("*.darwin-*.node"))
if not keyring_addons:
    raise SystemExit("No packaged darwin keyring addon found inside app bundle")
for addon in keyring_addons:
    if addon not in machos:
        raise SystemExit(f"Packaged keyring addon is not a recognized Mach-O binary: {addon}")

if team_id:
    widget_plist = plistlib.loads((app_dir / "Contents" / "PlugIns" / "EasyProxyWidget.appex" / "Contents" / "Info.plist").read_bytes())
    expected_group = f"{team_id}.com.easyproxy.desktop"
    if widget_plist.get("EasyProxyAppGroup") != expected_group:
        raise SystemExit(f"Widget Info.plist EasyProxyAppGroup mismatch: {widget_plist.get('EasyProxyAppGroup')!r} != {expected_group!r}")

for member in machos:
    verify = subprocess.run(["codesign", "--verify", "--strict", str(member)], capture_output=True, text=True)
    if verify.returncode != 0:
        raise SystemExit(f"codesign --verify --strict failed for {member}: {verify.stderr.strip()}")
    if team_id:
        display = subprocess.run(["codesign", "-dvvv", str(member)], capture_output=True, text=True)
        info = display.stdout + "\n" + display.stderr
        if display.returncode != 0:
            raise SystemExit(f"codesign -dvvv failed for {member}: {info.strip()}")
        if not re.search(rf"^TeamIdentifier={re.escape(team_id)}$", info, re.MULTILINE):
            raise SystemExit(f"Missing TeamIdentifier={team_id} on {member}")
        if not re.search(r"flags=.*\bruntime\b", info):
            raise SystemExit(f"Missing hardened runtime on {member}")

print(f"Verified {len(machos)} Mach-O binaries inside {app_dir.name}")
PY
# Release stripping removes the nlist symbol table; inspect the loader's bindings.
xcrun llvm-objdump --macho --dyld-info "$app/Contents/MacOS/$executable" > "$scratch/native-symbols.txt"
grep -q NSGlassEffectView "$scratch/native-symbols.txt" || { echo 'Native Liquid Glass code is absent' >&2; exit 1; }
mkdir "$scratch/home"
EASYPROXY_HOME="$scratch/home" "$app/Contents/MacOS/epx" resolve --json > "$scratch/resolve.json"
python3 - "$scratch/resolve.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value.get("schema") == "epx-resolve/1", "Unexpected resolve schema"
assert value.get("liveness", {}).get("status") in ("live", "absent-proven"), "Unusable resolve result"
PY

# Reproduce the packaged-keyring boundary from an unrelated cwd. This is deliberately load-only:
# an ad-hoc CI identity can trigger a Keychain consent dialog, while issue #6139 is module resolution.
mkdir -p "$scratch/home" "$scratch/work"
python3 - "$app/Contents/MacOS/epx" "$scratch/work" "$scratch/home" "$scratch/keyring.json" <<'PY'
import os, pathlib, subprocess, sys
epx, work, home, output = sys.argv[1:]
env = os.environ.copy()
env.update(HOME=home, EASYPROXY_HOME=str(pathlib.Path(home) / ".easyproxy"))
try:
    with open(output, "wb") as stdout:
        subprocess.run(
            [epx, "__keyring-load-check"], cwd=work, env=env, stdout=stdout,
            stderr=subprocess.PIPE, check=True, timeout=15,
        )
except subprocess.TimeoutExpired as error:
    raise SystemExit("Packaged keyring load probe timed out") from error
except subprocess.CalledProcessError as error:
    sys.stderr.buffer.write((error.stderr or b"")[-4096:])
    raise SystemExit(f"Packaged keyring load probe exited {error.returncode}") from error
PY
python3 - "$scratch/keyring.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value == {"schema": "epx-keyring-load/1", "available": True}, "Packaged keyring binding is unavailable"
PY
printf '%s\n' 'PASS: macOS signatures, entitlements, hardened runtime, Liquid Glass, bundled CLI resolve and packaged keyring'
