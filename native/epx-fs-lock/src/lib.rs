#![deny(unsafe_op_in_unsafe_fn)]

pub mod lock;
pub mod symlink;
#[cfg(windows)]
pub mod windows_acl;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsAclPolicy {
    pub directory: bool,
    pub grant_system_and_admins: bool,
    pub allow_admin_owner: bool,
    pub require_dacl_protected: bool,
}

impl WindowsAclPolicy {
    pub const fn epx_child(directory: bool) -> Self {
        Self {
            directory,
            grant_system_and_admins: directory,
            allow_admin_owner: true,
            require_dacl_protected: true,
        }
    }

    pub const fn desktop_harden(directory: bool) -> Self {
        Self {
            directory,
            grant_system_and_admins: true,
            allow_admin_owner: false,
            require_dacl_protected: true,
        }
    }

    pub const fn desktop_verify(directory: bool, root: bool) -> Self {
        Self {
            directory,
            grant_system_and_admins: true,
            allow_admin_owner: false,
            require_dacl_protected: root,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WindowsAclPolicy;
    use super::lock::{FileLock, LockMode, open_lock_file};
    use super::symlink::{is_symlink_or_reparse, reject_ancestor_symlinks, reject_symlink};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
            let dir = base.join(format!(
                "epx-fs-lock-{label}-{}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exclusive_lock_blocks_second_nonblocking_attempt_until_drop() {
        let scratch = Scratch::new("excl");
        let lock_path = scratch.0.join("state.lock");

        let guard = FileLock::open(&lock_path, LockMode::Exclusive, false).unwrap();
        let second = FileLock::open(&lock_path, LockMode::Exclusive, false);
        assert!(second.as_ref().is_err_and(|err| err.is_would_block()));

        drop(guard);
        let reacquired = FileLock::open(&lock_path, LockMode::Exclusive, false).unwrap();
        drop(reacquired);
    }

    #[test]
    fn blocking_lock_waits_for_holder_drop() {
        let scratch = Scratch::new("blocking");
        let lock_path = scratch.0.join("blocking.lock");

        let guard = FileLock::open(&lock_path, LockMode::Exclusive, true).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let wait_path = lock_path.clone();
        let waiter = std::thread::spawn(move || {
            let acquired = FileLock::open(&wait_path, LockMode::Exclusive, true).unwrap();
            tx.send(()).unwrap();
            drop(acquired);
        });

        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(80))
                .is_err(),
            "blocking lock acquired while still held"
        );
        drop(guard);
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("blocking lock did not unblock after Drop");
        waiter.join().unwrap();
    }

    #[test]
    fn shared_locks_coexist_and_conflict_with_exclusive() {
        let scratch = Scratch::new("shared");
        let lock_path = scratch.0.join("shared.lock");

        let s1 = FileLock::open(&lock_path, LockMode::Shared, false).unwrap();
        let s2 = FileLock::open(&lock_path, LockMode::Shared, false).unwrap();

        let excl_while_shared = FileLock::open(&lock_path, LockMode::Exclusive, false);
        assert!(
            excl_while_shared
                .as_ref()
                .is_err_and(|err| err.is_would_block())
        );

        drop(s1);
        assert!(
            FileLock::open(&lock_path, LockMode::Exclusive, false)
                .as_ref()
                .is_err_and(|err| err.is_would_block())
        );

        drop(s2);
        let excl = FileLock::open(&lock_path, LockMode::Exclusive, false).unwrap();
        let shared_while_excl = FileLock::open(&lock_path, LockMode::Shared, false);
        assert!(
            shared_while_excl
                .as_ref()
                .is_err_and(|err| err.is_would_block())
        );
        drop(excl);
    }

    #[test]
    fn explicit_unlock_and_file_clone_preserve_release_semantics() {
        let scratch = Scratch::new("unlock");
        let lock_path = scratch.0.join("cli.lock");

        let first = FileLock::open(&lock_path, LockMode::Exclusive, false).unwrap();
        let _dup = first.file().try_clone().unwrap();
        first.unlock().unwrap();

        let second = FileLock::open(&lock_path, LockMode::Exclusive, false).unwrap();
        drop(first);
        assert!(
            FileLock::open(&lock_path, LockMode::Exclusive, false)
                .as_ref()
                .is_err_and(|err| err.is_would_block())
        );
        drop(second);
    }

    #[cfg(unix)]
    #[test]
    fn reject_symlink_and_ancestors_refuse_unix_symlinks() {
        use std::os::unix::fs::symlink;

        let scratch = Scratch::new("sym");
        let real_dir = scratch.0.join("real");
        let real_file = real_dir.join("file.txt");
        let missing_file = real_dir.join("missing.txt");
        fs::create_dir(&real_dir).unwrap();
        fs::write(&real_file, b"ok").unwrap();

        assert!(!is_symlink_or_reparse(&fs::symlink_metadata(&real_file).unwrap()));
        reject_symlink(&real_file).unwrap();
        reject_symlink(&missing_file).unwrap();
        reject_ancestor_symlinks(&real_file).unwrap();
        reject_ancestor_symlinks(&real_dir.join("future/leaf.txt")).unwrap();

        let file_link = scratch.0.join("file.link");
        symlink(&real_file, &file_link).unwrap();
        assert!(is_symlink_or_reparse(
            &fs::symlink_metadata(&file_link).unwrap()
        ));
        assert!(reject_symlink(&file_link).is_err());

        let dangling_link = scratch.0.join("dangling.link");
        symlink(scratch.0.join("absent-target"), &dangling_link).unwrap();
        assert!(reject_symlink(&dangling_link).is_err());

        let dir_link = scratch.0.join("dir.link");
        symlink(&real_dir, &dir_link).unwrap();
        assert!(reject_ancestor_symlinks(&dir_link.join("file.txt")).is_err());
        assert!(reject_ancestor_symlinks(&dir_link.join("missing/leaf.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn nofollow_lock_open_refuses_preexisting_and_swapped_symlinks() {
        use std::os::unix::fs::symlink;

        let scratch = Scratch::new("nofollow");
        let target = scratch.0.join("outside-target");
        let link_lock = scratch.0.join("lock-via-link");
        symlink(&target, &link_lock).unwrap();

        assert!(open_lock_file(&link_lock).is_err());
        assert!(FileLock::open(&link_lock, LockMode::Exclusive, false).is_err());
        assert!(!target.exists(), "open followed symlink and created target");

        let raced_lock = scratch.0.join("raced.lock");
        let raced_res =
            FileLock::open_with_barrier(&raced_lock, LockMode::Exclusive, false, || {
                symlink(&target, &raced_lock).unwrap();
            });
        assert!(raced_res.is_err());
        assert!(
            !target.exists(),
            "open_with_barrier followed swapped symlink"
        );
    }

    #[test]
    fn open_lock_file_refuses_directory_target() {
        let scratch = Scratch::new("dir-lock");
        let dir_path = scratch.0.join("dir.lock");
        fs::create_dir(&dir_path).unwrap();
        assert!(open_lock_file(&dir_path).is_err());
    }

    #[test]
    fn windows_acl_policy_presets_preserve_consumer_differences() {
        let child_file = WindowsAclPolicy::epx_child(false);
        assert_eq!(
            child_file,
            WindowsAclPolicy {
                directory: false,
                grant_system_and_admins: false,
                allow_admin_owner: true,
                require_dacl_protected: true,
            }
        );

        let child_dir = WindowsAclPolicy::epx_child(true);
        assert_eq!(
            child_dir,
            WindowsAclPolicy {
                directory: true,
                grant_system_and_admins: true,
                allow_admin_owner: true,
                require_dacl_protected: true,
            }
        );

        let desktop_file_harden = WindowsAclPolicy::desktop_harden(false);
        assert_eq!(
            desktop_file_harden,
            WindowsAclPolicy {
                directory: false,
                grant_system_and_admins: true,
                allow_admin_owner: false,
                require_dacl_protected: true,
            }
        );

        let desktop_dir_harden = WindowsAclPolicy::desktop_harden(true);
        assert_eq!(
            desktop_dir_harden,
            WindowsAclPolicy {
                directory: true,
                grant_system_and_admins: true,
                allow_admin_owner: false,
                require_dacl_protected: true,
            }
        );

        let desktop_root_verify = WindowsAclPolicy::desktop_verify(true, true);
        assert_eq!(
            desktop_root_verify,
            WindowsAclPolicy {
                directory: true,
                grant_system_and_admins: true,
                allow_admin_owner: false,
                require_dacl_protected: true,
            }
        );

        let desktop_child_verify = WindowsAclPolicy::desktop_verify(false, false);
        assert_eq!(
            desktop_child_verify,
            WindowsAclPolicy {
                directory: false,
                grant_system_and_admins: true,
                allow_admin_owner: false,
                require_dacl_protected: false,
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_acl_harden_create_and_verify_policies_behave_as_specified() {
        use super::windows_acl::{create_private_file, harden_path, verify_path};
        use std::io::Write;
        use std::process::Command;

        let scratch = Scratch::new("win-acl");
        let grant = Command::new("icacls")
            .arg(&scratch.0)
            .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
            .output()
            .unwrap();
        assert!(grant.status.success());

        let child_dir = scratch.0.join("child-root");
        fs::create_dir(&child_dir).unwrap();
        harden_path(&child_dir, WindowsAclPolicy::epx_child(true)).unwrap();

        let child_secret = child_dir.join("secret.txt");
        let mut f = create_private_file(&child_secret, WindowsAclPolicy::epx_child(false)).unwrap();
        f.write_all(b"secret").unwrap();
        drop(f);
        verify_path(&child_secret, WindowsAclPolicy::epx_child(false)).unwrap();

        let desktop_root = scratch.0.join("desktop-root");
        fs::create_dir(&desktop_root).unwrap();
        harden_path(&desktop_root, WindowsAclPolicy::desktop_harden(true)).unwrap();
        let inherited = desktop_root.join("inherited.txt");
        fs::write(&inherited, b"inherited").unwrap();
        verify_path(&inherited, WindowsAclPolicy::desktop_verify(false, false)).unwrap();
        assert!(verify_path(&inherited, WindowsAclPolicy::desktop_verify(false, true)).is_err());
    }
}
