#!/usr/bin/env python3
"""Keep the compiled Bun sidecar intact while linuxdeploy patches the host/libs."""
import os
from pathlib import Path
import sys


APPDIR_PREFIX = (
    "release",
    "bundle",
    "appimage",
    "EasyProxy.AppDir",
    "usr",
)
APPDIR_SIDECAR_TAIL = (*APPDIR_PREFIX, "bin", "epx")
APPDIR_NATIVE_BIN_INFIX = (*APPDIR_PREFIX, "lib", "EasyProxy", "native-bin")


def _appdir_relative_parts(candidate, target_root):
    """Return candidate path parts relative to target_root without dereferencing candidate."""
    try:
        unfollowed = candidate.parent.resolve() / candidate.name
        return unfollowed.relative_to(target_root.resolve()).parts
    except ValueError:
        return None


def prepared_sidecar(root, candidate, target_root):
    """Return the one prepared Linux CLI that the AppDir sidecar exactly mirrors."""
    parts = _appdir_relative_parts(candidate, target_root)
    if parts is None or tuple(parts[-len(APPDIR_SIDECAR_TAIL):]) != APPDIR_SIDECAR_TAIL:
        return None
    prefix = parts[:-len(APPDIR_SIDECAR_TAIL)]
    if len(prefix) > 1 or not candidate.is_file():
        return None

    binaries = root / "desktop/src-tauri/binaries"
    candidates = sorted(
        path for path in binaries.glob("epx-*-linux-gnu")
        if path.is_file() and not path.is_symlink()
    )
    if prefix:
        candidates = [path for path in candidates if path.name == f"epx-{prefix[0]}"]
    matches = [path for path in candidates if path.read_bytes() == candidate.read_bytes()]
    return matches[0] if len(matches) == 1 else None


def prepared_native_helper(root, candidate, target_root):
    """Return the staged native-bin helper matching candidate bytes if inside AppDir."""
    parts = _appdir_relative_parts(candidate, target_root)
    if parts is None or len(parts) < len(APPDIR_NATIVE_BIN_INFIX) + 2:
        return None
    arch_dir, helper_name = parts[-2], parts[-1]
    body = parts[:-2]
    if tuple(body[-len(APPDIR_NATIVE_BIN_INFIX):]) != APPDIR_NATIVE_BIN_INFIX:
        return None
    if len(body[:-len(APPDIR_NATIVE_BIN_INFIX)]) > 1 or not candidate.is_file():
        return None

    prepared = root / "desktop/src-tauri/resources/native-bin" / arch_dir / helper_name
    if not prepared.is_file() or prepared.is_symlink():
        return None
    return prepared if prepared.read_bytes() == candidate.read_bytes() else None


def main(args):
    root = Path(__file__).resolve().parents[2]
    target_root = Path(os.environ.get("CARGO_TARGET_DIR", root / "desktop/src-tauri/target"))
    sidecar = Path(args[2]) if len(args) == 3 else None
    if (
        sidecar is not None
        and args[:2] == ["--set-rpath", "$ORIGIN/../lib"]
        and prepared_sidecar(root, sidecar, target_root) is not None
    ):
        # linuxdeploy's nested GTK pass runs ldd again after patching. Its
        # patchelf rewrite breaks the compiled Bun ELF. This sidecar depends
        # only on host glibc libraries; it needs no AppDir library search path.
        # Never bless an already-modified binary or a different executable.
        if sidecar.is_symlink():
            raise RuntimeError("AppImage sidecar differs from the prepared CLI")
        print("Preserving compiled epx bytes (no AppDir RPATH required)", file=sys.stderr)
        return
    if (
        sidecar is not None
        and len(args) == 3
        and args[0] == "--set-rpath"
        and (args[1] == "$ORIGIN" or args[1].startswith("$ORIGIN/"))
        and prepared_native_helper(root, sidecar, target_root) is not None
    ):
        # native-bin helpers (such as epx-child) are checksummed against SHA256SUMS
        # at staging time and link only host libc; rewriting RPATH breaks verification.
        if sidecar.is_symlink():
            raise RuntimeError("AppImage native helper differs from the prepared binary")
        print(f"Preserving prepared native helper {sidecar.name} bytes (SHA256SUMS-verified)", file=sys.stderr)
        return
    os.execv("/usr/bin/patchelf", ["/usr/bin/patchelf", *args])


if __name__ == "__main__":
    main(sys.argv[1:])
