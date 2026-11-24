use std::fs;
use std::path::Path;

/// `O_NOFOLLOW` flag for `open(2)` on Unix targets.
#[cfg(unix)]
pub const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;

/// Returns `true` if `meta` represents a symbolic link or (on Windows) a reparse point.
pub fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Reject `path` if it is a symbolic link or (on Windows) a reparse point.
/// Missing paths (`NotFound`) are accepted so callers can inspect target paths before creation.
pub fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("refusing symlinked path: {}", path.display()))
        }
        #[cfg(windows)]
        Ok(meta) => {
            if is_symlink_or_reparse(&meta) {
                return Err(format!("refusing reparse point: {}", path.display()));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to inspect {}: {e}", path.display())),
    }
}

/// Reject `path` if any of its ancestor directories is a symbolic link or (on Windows) a reparse point.
pub fn reject_ancestor_symlinks(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().skip(1) {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        reject_symlink(ancestor)?;
    }
    Ok(())
}
