use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryIdentity {
    pub volume: u64,
    pub file_id: [u8; 16],
}

pub fn directory_identity(path: &Path) -> Result<DirectoryIdentity, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let directory = File::open(path).map_err(|e| format!("cannot open directory: {e}"))?;
        let metadata = directory
            .metadata()
            .map_err(|e| format!("cannot inspect directory: {e}"))?;
        if !metadata.is_dir() {
            return Err("expected a directory".to_owned());
        }
        let mut file_id = [0u8; 16];
        file_id[..8].copy_from_slice(&metadata.ino().to_le_bytes());
        Ok(DirectoryIdentity {
            volume: metadata.dev(),
            file_id,
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct FileIdInfo {
            volume: u64,
            file_id: [u8; 16],
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandleEx(
                file: *mut std::ffi::c_void,
                class: u32,
                info: *mut std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)
            .map_err(|e| format!("cannot open directory: {e}"))?;
        let metadata = directory
            .metadata()
            .map_err(|e| format!("cannot inspect directory: {e}"))?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("expected a directory".to_owned());
        }
        let mut info = FileIdInfo {
            volume: 0,
            file_id: [0; 16],
        };
        // SAFETY: The open directory handle and output buffer remain valid for the call.
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                18,
                (&mut info as *mut FileIdInfo).cast(),
                std::mem::size_of::<FileIdInfo>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "cannot inspect directory identity: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(DirectoryIdentity {
            volume: info.volume,
            file_id: info.file_id,
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err("directory identity is unavailable on this platform".to_owned())
    }
}

/// Zeroes sensitive heap bytes on drop using volatile writes so the compiler cannot elide scrubbing.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        volatile_zero_bytes(&mut self.0);
    }
}

/// A secret string that is wiped on drop, so every copy of it (a clone, or a state read that is
/// dropped) is scrubbed. Serialized as a plain string; `Debug` never prints it.
#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::ops::Deref for SecretString {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        // SAFETY: Zero bytes are valid UTF-8, so the string stays valid while it is wiped.
        volatile_zero_bytes(unsafe { self.0.as_bytes_mut() });
    }
}

pub fn volatile_zero_bytes(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        // SAFETY: `byte` is a valid mutable reference to an initialized `u8` inside `buf`.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&sha256_bytes(data))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(LUT[(b >> 4) as usize] as char);
        out.push(LUT[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode_lower(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble_lower(bytes[i])?;
        let lo = hex_nibble_lower(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn hex_nibble_lower(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(1_760_000_000_000)
}

/// Formats epoch milliseconds as ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn format_iso8601_utc(epoch_ms: u64) -> String {
    let total_secs = (epoch_ms / 1000) as i64;
    let millis = epoch_ms % 1000;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    // Howard Hinnant civil_from_days algorithm
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(unix)]
unsafe extern "C" {
    fn setsid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
    fn GetStdHandle(std_handle: u32) -> *mut std::ffi::c_void;
    fn SetHandleInformation(object: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
}

#[cfg(windows)]
fn clear_parent_stdio_inheritance() {
    const STD_INPUT_HANDLE: u32 = (-10i32) as u32;
    const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
    const STD_ERROR_HANDLE: u32 = (-12i32) as u32;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    let invalid = (-1isize) as *mut std::ffi::c_void;
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: Clearing `HANDLE_FLAG_INHERIT` on valid standard handles prevents
        // detached grandchildren from keeping caller stdout/stderr pipes open after exit.
        unsafe {
            let h = GetStdHandle(which);
            if !h.is_null() && h != invalid {
                let _ = SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        bytes: u32,
        flags: u32,
    ) -> i32;
}

pub fn fill_random_bytes(dest: &mut [u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut f =
            File::open("/dev/urandom").map_err(|e| format!("failed to open /dev/urandom: {e}"))?;
        f.read_exact(dest)
            .map_err(|e| format!("failed to read /dev/urandom: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        // SAFETY: `dest` is a valid mutable slice of `dest.len()` bytes.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                dest.as_mut_ptr(),
                dest.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!(
                "BCryptGenRandom failed with NTSTATUS 0x{status:08x}"
            ));
        }
        Ok(())
    }
}

pub fn random_hex(byte_len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; byte_len];
    fill_random_bytes(&mut buf)?;
    Ok(hex_encode(&buf))
}

pub use epx_fs_lock::symlink::reject_symlink;

#[cfg(all(test, windows))]
mod windows_acl_tests {
    use super::*;
    use epx_fs_lock::WindowsAclPolicy;
    use epx_fs_lock::windows_acl::{create_private_file, harden_path, verify_path};
    use std::io::Write;
    use std::process::Command;

    #[test]
    fn regular_replacement_is_private_under_a_permissive_parent() {
        struct Scratch(std::path::PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        let root = std::env::temp_dir().join(format!(
            "epx-child-acl-{}-{}",
            std::process::id(),
            crate::platform::random_hex(6).unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let _scratch = Scratch(root.clone());
        let grant = Command::new("icacls")
            .arg(&root)
            .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
            .output()
            .unwrap();
        assert!(
            grant.status.success(),
            "could not make fixture parent permissive"
        );
        let config = root.join("config.toml");
        fs::write(&config, b"original").unwrap();
        let file_policy = WindowsAclPolicy::epx_child(false);
        harden_path(&config, file_policy).unwrap();

        let temp = root.join("new-private.tmp");
        let mut created = create_private_file(&temp, file_policy).unwrap();
        verify_path(&temp, file_policy).unwrap();
        created.write_all(b"fixture").unwrap();
        drop(created);

        crate::platform::write_regular_atomic(&config, b"replacement").unwrap();
        verify_path(&config, file_policy).unwrap();
        assert_eq!(fs::read(config).unwrap(), b"replacement");
    }
}

pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    reject_symlink(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !dir.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder
                .create(dir)
                .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        }
        reject_symlink(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to chmod 0700 {}: {e}", dir.display()))?;
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        reject_symlink(dir)?;
        epx_fs_lock::windows_acl::harden_path(dir, epx_fs_lock::WindowsAclPolicy::epx_child(true))?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        reject_symlink(dir)?;
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    let directory =
        File::open(parent).map_err(|e| format!("failed to open parent directory: {e}"))?;
    directory
        .sync_all()
        .map_err(|e| format!("failed to sync parent directory: {e}"))
}

pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    ensure_private_dir(parent)?;
    reject_symlink(path)?;
    let nonce = random_hex(8)?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = parent.join(format!(".{file_name}.tmp.{}.{nonce}", std::process::id()));
    #[cfg(windows)]
    let mut f = epx_fs_lock::windows_acl::create_private_file(
        &tmp,
        epx_fs_lock::WindowsAclPolicy::epx_child(false),
    )?;
    #[cfg(not(windows))]
    let mut f = {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&tmp)
            .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?
    };
    if let Err(e) = f.write_all(bytes).and_then(|()| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("failed writing {}: {e}", tmp.display()));
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed renaming {} -> {}: {e}",
            tmp.display(),
            path.display()
        ));
    }
    #[cfg(unix)]
    sync_parent_directory(parent)?;
    Ok(())
}

pub fn write_regular_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    reject_symlink(path)?;
    #[cfg(unix)]
    let preserved_mode = fs::metadata(path).ok().map(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o777
    });
    let nonce = random_hex(8)?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = parent.join(format!(
        ".{file_name}.epx-child.tmp.{}.{nonce}",
        std::process::id()
    ));
    #[cfg(windows)]
    let mut f = epx_fs_lock::windows_acl::create_private_file(
        &tmp,
        epx_fs_lock::WindowsAclPolicy::epx_child(false),
    )?;
    #[cfg(not(windows))]
    let mut f = {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(preserved_mode.unwrap_or(0o600));
        }
        opts.open(&tmp)
            .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?
    };
    if let Err(e) = f.write_all(bytes).and_then(|()| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("failed writing {}: {e}", tmp.display()));
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed renaming {} -> {}: {e}",
            tmp.display(),
            path.display()
        ));
    }
    #[cfg(unix)]
    sync_parent_directory(parent)?;
    Ok(())
}

pub struct FileLock {
    _inner: epx_fs_lock::lock::FileLock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAcquireError {
    Busy,
    Io,
}

/// What a lock acquisition does with the lock file's parent directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockParentAction {
    /// The parent is missing and epx-child creates it, private, as its own directory.
    CreatePrivate,
    /// The parent already exists; its permissions are never changed. It may be an
    /// `EASYPROXY_HOME` shared with a full EasyProxy install, or `CODEX_HOME`.
    UseExisting,
    Refuse,
}

/// `parent` is the parent's metadata, or `None` when it does not exist.
pub fn lock_parent_action(parent: Option<&fs::Metadata>, create_missing: bool) -> LockParentAction {
    match parent {
        None if create_missing => LockParentAction::CreatePrivate,
        None => LockParentAction::Refuse,
        Some(meta) if meta.is_dir() => LockParentAction::UseExisting,
        Some(_) => LockParentAction::Refuse,
    }
}

/// Create `dir` private (`0700`, or a protected owner-only DACL on Windows) if it is missing.
/// Returns whether this call created it. A directory that already exists, including one another
/// process creates concurrently, is left exactly as it is.
pub fn create_private_dir_if_missing(dir: &Path) -> Result<bool, String> {
    if let Some(ancestor) = dir.parent().filter(|p| !p.as_os_str().is_empty()) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(ancestor)
                .map_err(|e| format!("failed to create {}: {e}", ancestor.display()))?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(ancestor)
            .map_err(|e| format!("failed to create {}: {e}", ancestor.display()))?;
    }
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let created = fs::DirBuilder::new().create(dir);
    match created {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return if fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
                Ok(false)
            } else {
                Err(format!("{} exists and is not a directory", dir.display()))
            };
        }
        Err(e) => return Err(format!("failed to create {}: {e}", dir.display())),
    }
    reject_symlink(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to chmod 0700 {}: {e}", dir.display()))?;
    }
    #[cfg(windows)]
    epx_fs_lock::windows_acl::harden_path(dir, epx_fs_lock::WindowsAclPolicy::epx_child(true))?;
    Ok(true)
}

impl FileLock {
    /// Lock `path`, creating its parent private only if it is missing. An existing parent keeps
    /// its permissions; the lock file itself is created owner-only.
    pub fn try_acquire_nonblocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, false, true, false)
    }

    pub fn acquire_blocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, true, true, false)
    }

    /// Lock a file inside a directory the caller does not own (such as `CODEX_HOME`), leaving
    /// the directory's permissions untouched. The lock file itself is created private.
    pub fn acquire_in_existing_dir(path: &Path, blocking: bool) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, blocking, false, false)
    }

    /// A shared (reader) lock on a file inside an existing directory, never blocking: many
    /// holders at once, refused only while someone holds it exclusively.
    pub fn try_acquire_shared_in_existing_dir(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, false, false, true)
    }

    fn acquire_inner(
        path: &Path,
        blocking: bool,
        create_missing_parent: bool,
        shared: bool,
    ) -> Result<Self, LockAcquireError> {
        let parent = path.parent().ok_or(LockAcquireError::Io)?;
        // A symlinked parent is refused rather than followed, as ensure_private_dir did.
        let parent_meta = fs::symlink_metadata(parent).ok();
        match lock_parent_action(parent_meta.as_ref(), create_missing_parent) {
            LockParentAction::CreatePrivate => {
                create_private_dir_if_missing(parent).map_err(|_| LockAcquireError::Io)?;
            }
            LockParentAction::UseExisting => {}
            LockParentAction::Refuse => return Err(LockAcquireError::Io),
        }
        reject_symlink(path).map_err(|_| LockAcquireError::Io)?;
        crate::test_hooks::barrier("lock-before-open");
        #[cfg(windows)]
        let existed = path.exists();
        let file = epx_fs_lock::lock::open_lock_file(path).map_err(|_| LockAcquireError::Io)?;
        #[cfg(windows)]
        {
            let policy = epx_fs_lock::WindowsAclPolicy::epx_child(false);
            let private = if existed {
                epx_fs_lock::windows_acl::verify_path(path, policy)
            } else {
                epx_fs_lock::windows_acl::harden_path(path, policy)
            };
            private.map_err(|_| LockAcquireError::Io)?;
        }
        let mode = if shared {
            epx_fs_lock::lock::LockMode::Shared
        } else {
            epx_fs_lock::lock::LockMode::Exclusive
        };
        let inner =
            epx_fs_lock::lock::FileLock::lock_file(file, mode, blocking).map_err(|err| {
                if err.is_would_block() {
                    LockAcquireError::Busy
                } else {
                    LockAcquireError::Io
                }
            })?;
        Ok(Self { _inner: inner })
    }
}

/// Spawn `serve --foreground --lifecycle-start` and write `start_line` to its stdin, which
/// stays open: the caller later writes the commit line or drops it to make the child exit.
pub fn spawn_detached_serve(
    exe: &Path,
    easyproxy_home: &Path,
    codex_home: &Path,
    listen_port: u16,
    start_line: &[u8],
) -> Result<std::process::Child, String> {
    let build_cmd = || {
        let mut cmd = Command::new(exe);
        cmd.arg("serve")
            .arg("--foreground")
            .arg("--lifecycle-start")
            .arg("--listen-port")
            .arg(listen_port.to_string())
            .env("EASYPROXY_HOME", easyproxy_home)
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::test_hooks::strip_barrier_env(&mut cmd);
        cmd
    };

    #[cfg(unix)]
    let mut child = {
        use std::os::unix::process::CommandExt;
        let mut cmd = build_cmd();
        // SAFETY: `setsid()` is async-signal-safe in the forked child before exec.
        unsafe {
            cmd.pre_exec(|| {
                let _ = setsid();
                Ok(())
            });
        }
        cmd.spawn()
            .map_err(|e| format!("failed to spawn detached epx-child serve: {e}"))?
    };

    #[cfg(windows)]
    let mut child = {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        clear_parent_stdio_inheritance();
        let mut cmd = build_cmd();
        cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        match cmd.spawn() {
            Ok(c) => c,
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(5) =>
            {
                let mut fallback = build_cmd();
                fallback.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                fallback
                    .spawn()
                    .map_err(|e2| format!("failed to spawn detached epx-child serve: {e2}"))?
            }
            Err(e) => return Err(format!("failed to spawn detached epx-child serve: {e}")),
        }
    };
    let write_result = match child.stdin.as_mut() {
        Some(stdin) => stdin.write_all(start_line).and_then(|()| stdin.flush()),
        None => Err(std::io::Error::other("missing child stdin")),
    };
    if let Err(e) = write_result {
        let cleanup = child.kill().and_then(|()| child.wait().map(|_| ()));
        return Err(format!(
            "failed to authorize spawned child: {e}; cleanup: {cleanup:?}"
        ));
    }
    Ok(child)
}

pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: `kill(pid, 0)` sends no signal and probes process existence.
        let rc = unsafe { kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(1) // EPERM
    }
    #[cfg(windows)]
    {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_TIMEOUT: u32 = 258;
        // SAFETY: Opens a temporary SYNCHRONIZE handle for `pid` and closes it immediately.
        unsafe {
            let h = OpenProcess(SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let state = WaitForSingleObject(h, 0);
            CloseHandle(h);
            state == WAIT_TIMEOUT
        }
    }
}

pub fn resolve_user_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    if let Some(h) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    PathBuf::from(".")
}

pub fn resolve_easyproxy_home() -> PathBuf {
    if let Some(custom) = std::env::var_os("EASYPROXY_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(custom);
    }
    resolve_user_home().join(".easyproxy")
}

pub fn resolve_codex_home() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(custom);
    }
    resolve_user_home().join(".codex")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeExecutableOutcome {
    Removed,
    SkippedUnmanagedPath,
    /// Another epx-child relay (of any EasyProxy home) runs from the planted binary.
    InUse,
}

/// Lock file beside the managed planted binary. Every relay serving from that binary holds it
/// shared for its lifetime; a purge takes it exclusively, without waiting, and keeps the binary
/// when it cannot. The binary is one per OS user, shared by every epx-child home of that user.
pub const PLANT_IN_USE_LOCK: &str = ".epx-child-in-use.lock";

/// Hold the planted binary's in-use lock shared when `exe_path` is the managed planted binary.
/// Refuses while a purge holds it, so a relay never starts from a binary being removed. "Managed"
/// is decided by the path (the managed directory and name), never by the file still existing: a
/// relay whose binary a purge removed just before it took the lock finds it gone and refuses.
pub fn hold_managed_plant_in_use(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<Option<FileLock>, String> {
    // Linux names an unlinked executable "<path> (deleted)" in /proc/self/exe.
    let unlinked = exe_path
        .to_str()
        .and_then(|p| p.strip_suffix(" (deleted)"))
        .map(PathBuf::from);
    let exe_path = unlinked.as_deref().unwrap_or(exe_path);
    if !is_managed_plant_location(exe_path, user_home, local_appdata)? {
        return Ok(None);
    }
    let parent = exe_path
        .parent()
        .ok_or_else(|| "missing parent".to_owned())?;
    let lock = match FileLock::try_acquire_shared_in_existing_dir(&parent.join(PLANT_IN_USE_LOCK)) {
        Ok(lock) => lock,
        Err(LockAcquireError::Busy) => {
            return Err("the planted epx-child is being purged".to_owned());
        }
        Err(LockAcquireError::Io) => {
            return Err("cannot open the planted epx-child in-use lock".to_owned());
        }
    };
    if unlinked.is_some() || !fs::symlink_metadata(exe_path).is_ok_and(|m| m.file_type().is_file())
    {
        return Err("the planted epx-child was purged".to_owned());
    }
    Ok(Some(lock))
}

fn reject_managed_subpath_symlinks(root: &Path, components: &[&str]) -> Result<PathBuf, String> {
    let mut cur = root.to_path_buf();
    for comp in components {
        cur.push(comp);
        reject_symlink(&cur)?;
    }
    Ok(cur)
}

pub fn is_managed_plant_executable(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<bool, String> {
    reject_symlink(exe_path)?;
    if !fs::symlink_metadata(exe_path).is_ok_and(|m| m.file_type().is_file()) {
        return Ok(false);
    }
    is_managed_plant_location(exe_path, user_home, local_appdata)
}

/// `exe_path` names the managed planted binary (its directory and file name), whether or not the
/// file is there.
fn is_managed_plant_location(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<bool, String> {
    reject_symlink(exe_path)?;
    let Some(parent) = exe_path.parent() else {
        return Ok(false);
    };
    reject_symlink(parent)?;
    let expected_name = if cfg!(windows) {
        "epx-child.exe"
    } else {
        "epx-child"
    };
    if exe_path.file_name().and_then(|n| n.to_str()) != Some(expected_name) {
        return Ok(false);
    }
    let canon_parent = fs::canonicalize(parent)
        .map_err(|e| format!("failed canonicalizing {}: {e}", parent.display()))?;
    let cache_bin = reject_managed_subpath_symlinks(user_home, &[".cache", "easyproxy", "bin"])?;
    if fs::canonicalize(&cache_bin).ok().as_ref() == Some(&canon_parent) {
        return Ok(true);
    }
    if let Some(appdata) = local_appdata {
        let win_bin = reject_managed_subpath_symlinks(appdata, &["easyproxy", "bin"])?;
        if fs::canonicalize(&win_bin).ok().as_ref() == Some(&canon_parent) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn purge_managed_executable(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<PurgeExecutableOutcome, String> {
    if !is_managed_plant_executable(exe_path, user_home, local_appdata)? {
        return Ok(PurgeExecutableOutcome::SkippedUnmanagedPath);
    }
    let in_use_path = exe_path
        .parent()
        .ok_or_else(|| "missing parent".to_owned())?
        .join(PLANT_IN_USE_LOCK);
    let _exclusive = match FileLock::acquire_in_existing_dir(&in_use_path, false) {
        Ok(lock) => lock,
        Err(LockAcquireError::Busy) => return Ok(PurgeExecutableOutcome::InUse),
        Err(LockAcquireError::Io) => {
            return Err("cannot open the planted epx-child in-use lock".to_owned());
        }
    };
    crate::test_hooks::barrier("purge-holding-in-use");
    // The lock file stays: unlinking it while held would let a relay lock a fresh file of the same
    // name and keep serving while the binary goes. The emptied directory therefore stays as well.
    #[cfg(unix)]
    {
        fs::remove_file(exe_path).map_err(|e| {
            format!(
                "failed removing planted epx-child {}: {e}",
                exe_path.display()
            )
        })?;
        let _ = exe_path.parent().map(fs::remove_dir);
        let _ = exe_path.parent().and_then(Path::parent).map(fs::remove_dir);
        Ok(PurgeExecutableOutcome::Removed)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let parent = exe_path
            .parent()
            .ok_or_else(|| "missing parent".to_owned())?;
        let trashed = parent.join(format!(".epx-child.purge.{}.old", std::process::id()));
        let _ = fs::remove_file(&trashed);
        fs::rename(exe_path, &trashed)
            .map_err(|e| format!("failed renaming planted epx-child for purge: {e}"))?;
        clear_parent_stdio_inheritance();
        let _ = Command::new("cmd.exe")
            .args([
                "/d",
                "/c",
                "ping -n 2 127.0.0.1 >nul & del /f /q \"%EPX_PURGE_TARGET%\"",
            ])
            .env("EPX_PURGE_TARGET", &trashed)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn();
        Ok(PurgeExecutableOutcome::Removed)
    }
}

#[cfg(test)]
mod lock_parent_tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scratch() -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "epx-child-lock-parent-{}-{}",
            std::process::id(),
            random_hex(6).unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn only_a_missing_parent_is_created_and_an_existing_one_is_never_touched() {
        let root = scratch();
        let file = root.0.join("plain-file");
        fs::write(&file, b"x").unwrap();
        let dir_meta = fs::symlink_metadata(&root.0).unwrap();
        let file_meta = fs::symlink_metadata(&file).unwrap();
        assert_eq!(
            lock_parent_action(None, true),
            LockParentAction::CreatePrivate
        );
        assert_eq!(lock_parent_action(None, false), LockParentAction::Refuse);
        for create in [true, false] {
            assert_eq!(
                lock_parent_action(Some(&dir_meta), create),
                LockParentAction::UseExisting
            );
            assert_eq!(
                lock_parent_action(Some(&file_meta), create),
                LockParentAction::Refuse
            );
        }
    }

    #[test]
    fn create_private_dir_if_missing_reports_creation_and_keeps_existing_modes() {
        let root = scratch();
        let created = root.0.join("new").join("home");
        assert!(create_private_dir_if_missing(&created).unwrap());
        assert!(!create_private_dir_if_missing(&created).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&created), 0o700);
            let shared = root.0.join("shared");
            fs::create_dir(&shared).unwrap();
            fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(!create_private_dir_if_missing(&shared).unwrap());
            let lock = FileLock::acquire_blocking(&shared.join("child.lock")).unwrap();
            drop(lock);
            assert_eq!(mode(&shared), 0o755);
            assert_eq!(mode(&shared.join("child.lock")), 0o600);
        }
    }
}
#[cfg(test)]
mod managed_plant_in_use_tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn managed_home() -> (Scratch, PathBuf) {
        let home = std::env::temp_dir().join(format!(
            "epx-child-plant-in-use-{}-{}",
            std::process::id(),
            random_hex(6).unwrap()
        ));
        let bin = home.join(".cache").join("easyproxy").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) {
            "epx-child.exe"
        } else {
            "epx-child"
        });
        (Scratch(home), exe)
    }

    #[test]
    fn a_relay_whose_managed_binary_is_gone_refuses_instead_of_serving_unlocked() {
        let (home, exe) = managed_home();
        assert_eq!(
            hold_managed_plant_in_use(&exe, &home.0, None)
                .err()
                .as_deref(),
            Some("the planted epx-child was purged")
        );
        fs::write(&exe, b"binary").unwrap();
        assert!(
            hold_managed_plant_in_use(&exe, &home.0, None)
                .unwrap()
                .is_some()
        );
        #[cfg(target_os = "linux")]
        {
            // /proc/self/exe after the binary was unlinked.
            let deleted = PathBuf::from(format!("{} (deleted)", exe.display()));
            assert_eq!(
                hold_managed_plant_in_use(&deleted, &home.0, None)
                    .err()
                    .as_deref(),
                Some("the planted epx-child was purged")
            );
        }
    }

    #[test]
    fn a_binary_outside_the_managed_directory_holds_nothing() {
        let (home, _) = managed_home();
        let elsewhere = home.0.join("epx-child");
        fs::write(&elsewhere, b"binary").unwrap();
        assert!(
            hold_managed_plant_in_use(&elsewhere, &home.0, None)
                .unwrap()
                .is_none()
        );
    }
}
