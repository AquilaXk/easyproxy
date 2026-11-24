use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

use crate::symlink::{is_symlink_or_reparse, reject_symlink};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockMode {
    Shared,
    Exclusive,
}

#[derive(Debug)]
pub enum LockError {
    WouldBlock,
    Io(io::Error),
    InvalidPath(String),
}

impl LockError {
    pub fn is_would_block(&self) -> bool {
        matches!(self, Self::WouldBlock)
    }
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WouldBlock => f.write_str("lock is busy"),
            Self::Io(e) => write!(f, "lock I/O error: {e}"),
            Self::InvalidPath(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type HANDLE = *mut c_void;

    pub const LOCKFILE_FAIL_IMMEDIATELY: DWORD = 0x0000_0001;
    pub const LOCKFILE_EXCLUSIVE_LOCK: DWORD = 0x0000_0002;
    pub const ERROR_LOCK_VIOLATION: i32 = 33;

    #[repr(C)]
    pub struct Overlapped {
        pub internal: usize,
        pub internal_high: usize,
        pub offset: DWORD,
        pub offset_high: DWORD,
        pub event: HANDLE,
    }

    impl Overlapped {
        pub fn zero() -> Self {
            Self {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: std::ptr::null_mut(),
            }
        }
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn LockFileEx(
            file: HANDLE,
            flags: DWORD,
            reserved: DWORD,
            bytes_low: DWORD,
            bytes_high: DWORD,
            overlapped: *mut Overlapped,
        ) -> BOOL;
        pub fn UnlockFileEx(
            file: HANDLE,
            reserved: DWORD,
            bytes_low: DWORD,
            bytes_high: DWORD,
            overlapped: *mut Overlapped,
        ) -> BOOL;
    }
}

/// Opens (or creates) a lock file without following symlinks or Windows reparse points,
/// and verifies the opened handle refers to a plain regular file.
pub fn open_lock_file(path: &Path) -> Result<File, LockError> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(crate::symlink::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path).map_err(LockError::Io)?;
    let metadata = file.metadata().map_err(LockError::Io)?;
    if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
        return Err(LockError::InvalidPath(format!(
            "refusing non-regular or reparse lock path: {}",
            path.display()
        )));
    }
    Ok(file)
}

/// Advisory file lock (`flock(2)` on Unix, `LockFileEx` on Windows) that explicitly unlocks
/// before closing the underlying handle on `Drop`.
pub struct FileLock {
    file: File,
}

impl FileLock {
    pub fn open(path: &Path, mode: LockMode, blocking: bool) -> Result<Self, LockError> {
        Self::open_with_barrier(path, mode, blocking, || {})
    }

    pub fn open_with_barrier<F>(
        path: &Path,
        mode: LockMode,
        blocking: bool,
        before_open: F,
    ) -> Result<Self, LockError>
    where
        F: FnOnce(),
    {
        reject_symlink(path).map_err(LockError::InvalidPath)?;
        before_open();
        let file = open_lock_file(path)?;
        Self::lock_file(file, mode, blocking)
    }

    /// Acquires the advisory lock on an already-opened regular lock file.
    /// On failure, the caller's `File` is dropped without unlocking another holder's lock.
    pub fn lock_file(file: File, mode: LockMode, blocking: bool) -> Result<Self, LockError> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let op = match (mode, blocking) {
                (LockMode::Shared, true) => libc::LOCK_SH,
                (LockMode::Shared, false) => libc::LOCK_SH | libc::LOCK_NB,
                (LockMode::Exclusive, true) => libc::LOCK_EX,
                (LockMode::Exclusive, false) => libc::LOCK_EX | libc::LOCK_NB,
            };
            loop {
                // SAFETY: `file` owns an open, valid file descriptor for the call.
                let rc = unsafe { libc::flock(file.as_raw_fd(), op) };
                if rc == 0 {
                    return Ok(Self { file });
                }
                let err = io::Error::last_os_error();
                match err.raw_os_error() {
                    Some(code) if code == libc::EINTR => continue,
                    Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => {
                        return Err(LockError::WouldBlock);
                    }
                    _ => return Err(LockError::Io(err)),
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mode_flags = match mode {
                LockMode::Shared => 0,
                LockMode::Exclusive => win32::LOCKFILE_EXCLUSIVE_LOCK,
            };
            let flags = if blocking {
                mode_flags
            } else {
                mode_flags | win32::LOCKFILE_FAIL_IMMEDIATELY
            };
            let mut ov = win32::Overlapped::zero();
            // SAFETY: `file` owns a valid open Win32 handle and `ov` is stack-allocated.
            let ok = unsafe { win32::LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut ov) };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if !blocking
                    && (err.raw_os_error() == Some(win32::ERROR_LOCK_VIOLATION)
                        || err.kind() == io::ErrorKind::WouldBlock)
                {
                    return Err(LockError::WouldBlock);
                }
                return Err(LockError::Io(err));
            }
            Ok(Self { file })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (file, mode, blocking);
            Err(LockError::Io(io::Error::new(
                io::ErrorKind::Unsupported,
                "file locking is unsupported on this platform",
            )))
        }
    }

    pub fn file(&self) -> &File {
        &self.file
    }

    pub fn unlock(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            loop {
                // SAFETY: `self.file` stays open until `Drop` completes.
                let rc = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
                if rc == 0 {
                    return Ok(());
                }
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(err);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut ov = win32::Overlapped::zero();
            // SAFETY: `self.file` stays open until `Drop` completes and `ov` is stack-allocated.
            let ok = unsafe { win32::UnlockFileEx(self.file.as_raw_handle(), 0, 1, 0, &mut ov) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(())
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.unlock();
    }
}
