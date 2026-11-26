use std::ffi::c_void;
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr;

pub use crate::WindowsAclPolicy;

pub type BOOL = i32;
pub type DWORD = u32;
pub type WORD = u16;
pub type BYTE = u8;
pub type HANDLE = *mut c_void;
pub type HLOCAL = *mut c_void;
pub type LPVOID = *mut c_void;
pub type PSID = *mut c_void;
pub type PACL = *mut Acl;
#[allow(non_camel_case_types)]
pub type PSECURITY_DESCRIPTOR = *mut c_void;

pub const ACL_REVISION: DWORD = 2;
const SECURITY_DESCRIPTOR_REVISION: DWORD = 1;
const TOKEN_QUERY: DWORD = 0x8;
const TOKEN_USER_CLASS: DWORD = 1;
const WIN_LOCAL_SYSTEM_SID: DWORD = 22;
const WIN_BUILTIN_ADMINISTRATORS_SID: DWORD = 26;
pub const FULL_CONTROL: DWORD = 0x001f_01ff;
const GENERIC_ALL: DWORD = 0x1000_0000;
const OBJECT_INHERIT_ACE: DWORD = 0x1;
const CONTAINER_INHERIT_ACE: DWORD = 0x2;
const INHERIT_ONLY_ACE: BYTE = 0x8;
const INHERITED_ACE: BYTE = 0x10;
const ACCESS_ALLOWED_ACE_TYPE: BYTE = 0;
pub const SE_FILE_OBJECT: DWORD = 1;
const OWNER_SECURITY_INFORMATION: DWORD = 1;
pub const DACL_SECURITY_INFORMATION: DWORD = 4;
pub const PROTECTED_DACL_SECURITY_INFORMATION: DWORD = 0x8000_0000;
const SE_DACL_PROTECTED: WORD = 0x1000;
const GENERIC_WRITE: DWORD = 0x4000_0000;
const FILE_SHARE_ALL: DWORD = 0x0000_0007;
const CREATE_NEW: DWORD = 1;
const FILE_ATTRIBUTE_NORMAL: DWORD = 0x0000_0080;

#[repr(C)]
pub struct Acl {
    pub revision: BYTE,
    pub reserved: BYTE,
    pub size: WORD,
    pub count: WORD,
    pub reserved2: WORD,
}

#[repr(C)]
pub struct AceHeader {
    pub kind: BYTE,
    pub flags: BYTE,
    pub size: WORD,
}

#[repr(C)]
pub struct SecurityDescriptor {
    pub revision: BYTE,
    pub reserved: BYTE,
    pub control: WORD,
    pub owner: PSID,
    pub group: PSID,
    pub sacl: PACL,
    pub dacl: PACL,
}

#[repr(C)]
pub struct SecurityAttributes {
    pub length: DWORD,
    pub descriptor: PSECURITY_DESCRIPTOR,
    pub inherit_handle: BOOL,
}

pub mod sys {
    use super::{
        BOOL, DWORD, HANDLE, HLOCAL, LPVOID, PACL, PSECURITY_DESCRIPTOR, PSID, SecurityAttributes,
        WORD,
    };

    #[link(name = "advapi32")]
    unsafe extern "system" {
        pub fn OpenProcessToken(process: HANDLE, access: DWORD, token: *mut HANDLE) -> BOOL;
        pub fn GetTokenInformation(
            token: HANDLE,
            class: DWORD,
            info: LPVOID,
            size: DWORD,
            needed: *mut DWORD,
        ) -> BOOL;
        pub fn CreateWellKnownSid(
            kind: DWORD,
            domain: PSID,
            sid: PSID,
            size: *mut DWORD,
        ) -> BOOL;
        pub fn InitializeAcl(acl: PACL, size: DWORD, revision: DWORD) -> BOOL;
        pub fn AddAccessAllowedAceEx(
            acl: PACL,
            revision: DWORD,
            flags: DWORD,
            mask: DWORD,
            sid: PSID,
        ) -> BOOL;
        pub fn SetNamedSecurityInfoW(
            name: *mut u16,
            kind: DWORD,
            info: DWORD,
            owner: PSID,
            group: PSID,
            dacl: PACL,
            sacl: PACL,
        ) -> DWORD;
        pub fn GetNamedSecurityInfoW(
            name: *const u16,
            kind: DWORD,
            info: DWORD,
            owner: *mut PSID,
            group: *mut PSID,
            dacl: *mut PACL,
            sacl: *mut PACL,
            descriptor: *mut PSECURITY_DESCRIPTOR,
        ) -> DWORD;
        pub fn GetSecurityDescriptorControl(
            descriptor: PSECURITY_DESCRIPTOR,
            control: *mut WORD,
            revision: *mut DWORD,
        ) -> BOOL;
        pub fn GetSecurityDescriptorDacl(
            descriptor: PSECURITY_DESCRIPTOR,
            present: *mut BOOL,
            dacl: *mut PACL,
            defaulted: *mut BOOL,
        ) -> BOOL;
        pub fn EqualSid(a: PSID, b: PSID) -> BOOL;
        pub fn IsValidSid(sid: PSID) -> BOOL;
        pub fn IsValidAcl(acl: PACL) -> BOOL;
        pub fn GetAce(acl: PACL, index: DWORD, ace: *mut LPVOID) -> BOOL;
        pub fn GetLengthSid(sid: PSID) -> DWORD;
        pub fn InitializeSecurityDescriptor(
            descriptor: PSECURITY_DESCRIPTOR,
            revision: DWORD,
        ) -> BOOL;
        pub fn SetSecurityDescriptorDacl(
            descriptor: PSECURITY_DESCRIPTOR,
            present: BOOL,
            dacl: PACL,
            defaulted: BOOL,
        ) -> BOOL;
        pub fn SetSecurityDescriptorControl(
            descriptor: PSECURITY_DESCRIPTOR,
            mask: WORD,
            control: WORD,
        ) -> BOOL;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetCurrentProcess() -> HANDLE;
        pub fn CloseHandle(handle: HANDLE) -> BOOL;
        pub fn LocalFree(memory: HLOCAL) -> HLOCAL;
        pub fn CreateFileW(
            name: *const u16,
            access: DWORD,
            share: DWORD,
            attributes: *mut SecurityAttributes,
            disposition: DWORD,
            flags: DWORD,
            template: HANDLE,
        ) -> HANDLE;
    }
}

use sys::{
    AddAccessAllowedAceEx, CloseHandle, CreateFileW, CreateWellKnownSid, EqualSid, GetAce,
    GetCurrentProcess, GetLengthSid, GetNamedSecurityInfoW, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor,
    IsValidAcl, IsValidSid, LocalFree, OpenProcessToken, SetNamedSecurityInfoW,
    SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
};

pub struct Local(pub HLOCAL);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` was allocated by `GetNamedSecurityInfoW`.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

pub struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` is an open process token handle returned by `OpenProcessToken`.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let mut out: Vec<u16> = path.as_os_str().encode_wide().collect();
    if out.contains(&0) {
        return Err("private-acl-unsafe: interior NUL".to_owned());
    }
    out.push(0);
    Ok(out)
}

pub fn current_user_sid() -> Result<Vec<usize>, String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: Queries current process token for `TOKEN_QUERY`.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("private-acl-unsafe: OpenProcessToken failed".to_owned());
    }
    let token = Token(token);
    let mut needed: DWORD = 0;
    // SAFETY: First call sizes `TokenUser` (1).
    unsafe {
        GetTokenInformation(token.0, TOKEN_USER_CLASS, ptr::null_mut(), 0, &mut needed);
    }
    if needed < std::mem::size_of::<usize>() as DWORD || needed > 65_536 {
        return Err("private-acl-unsafe: invalid token user size".to_owned());
    }
    let mut buf = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: `buf` has `>= needed` bytes aligned to `usize`.
    if unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_USER_CLASS,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err("private-acl-unsafe: GetTokenInformation failed".to_owned());
    }
    // SAFETY: `buf[0]` holds the `PSID` pointer inside `TOKEN_USER`.
    if unsafe { IsValidSid(buf[0] as PSID) } == 0 {
        return Err("private-acl-unsafe: invalid user SID".to_owned());
    }
    Ok(buf)
}

pub fn well_known_sid(kind: DWORD) -> Result<[u32; 17], String> {
    // SECURITY_MAX_SID_SIZE is 68 bytes. Caller-owned, DWORD-aligned storage
    // needs no LocalFree/FreeSid and remains alive while building/verifying the ACL.
    let mut sid = [0u32; 17];
    let mut size = std::mem::size_of_val(&sid) as DWORD;
    // SAFETY: `sid` is 68 bytes (`SECURITY_MAX_SID_SIZE`), DWORD-aligned.
    if unsafe { CreateWellKnownSid(kind, ptr::null_mut(), sid.as_mut_ptr().cast(), &mut size) }
        == 0
    {
        return Err("private-acl-unsafe: CreateWellKnownSid failed".to_owned());
    }
    Ok(sid)
}

pub fn build_allowed_acl(sids: &[PSID], flags: DWORD) -> Result<Vec<u32>, String> {
    let mut acl_bytes = std::mem::size_of::<Acl>() as DWORD;
    for &sid in sids {
        // SAFETY: Callers pass SIDs validated by `IsValidSid` or `CreateWellKnownSid`.
        let sid_len = unsafe { GetLengthSid(sid) };
        acl_bytes = acl_bytes
            .checked_add(8 + sid_len)
            .ok_or_else(|| "private-acl-unsafe: ACL size overflow".to_owned())?;
    }
    let mut acl_buf = vec![0u32; (acl_bytes as usize).div_ceil(std::mem::size_of::<u32>())];
    let acl_ptr = acl_buf.as_mut_ptr().cast::<Acl>();
    // SAFETY: `acl_buf` has `>= acl_bytes` DWORD-aligned capacity.
    if unsafe { InitializeAcl(acl_ptr, acl_bytes, ACL_REVISION) } == 0 {
        return Err("private-acl-unsafe: InitializeAcl failed".to_owned());
    }
    for &sid in sids {
        // SAFETY: `acl_ptr` was initialized with room for all `sids`.
        if unsafe { AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, FULL_CONTROL, sid) } == 0 {
            return Err("private-acl-unsafe: AddAccessAllowedAceEx failed".to_owned());
        }
    }
    Ok(acl_buf)
}

fn build_policy_acl(
    policy: WindowsAclPolicy,
) -> Result<(Vec<usize>, [u32; 17], [u32; 17], Vec<u32>), String> {
    let user = current_user_sid()?;
    let mut system = well_known_sid(WIN_LOCAL_SYSTEM_SID)?;
    let mut admins = well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID)?;
    let sids: Vec<PSID> = if policy.grant_system_and_admins {
        vec![
            user[0] as PSID,
            system.as_mut_ptr().cast(),
            admins.as_mut_ptr().cast(),
        ]
    } else {
        vec![user[0] as PSID]
    };
    let flags = if policy.directory {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    let acl_buf = build_allowed_acl(&sids, flags)?;
    Ok((user, system, admins, acl_buf))
}

pub fn verify_path(path: &Path, policy: WindowsAclPolicy) -> Result<(), String> {
    let user = current_user_sid()?;
    let mut system = well_known_sid(WIN_LOCAL_SYSTEM_SID)?;
    let mut admins = well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID)?;
    verify_with_sids(path, policy, &user, &mut system, &mut admins)
}

pub fn harden_path(path: &Path, policy: WindowsAclPolicy) -> Result<(), String> {
    let (user, mut system, mut admins, mut acl_buf) = build_policy_acl(policy)?;
    let acl_ptr = acl_buf.as_mut_ptr().cast::<Acl>();
    let mut wname = wide(path)?;
    // SAFETY: `wname` is NUL-terminated and `acl_ptr` remains valid through the call.
    if unsafe {
        SetNamedSecurityInfoW(
            wname.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl_ptr,
            ptr::null_mut(),
        )
    } != 0
    {
        return Err(format!(
            "private-acl-unsafe: SetNamedSecurityInfoW failed on {}",
            path.display()
        ));
    }
    verify_with_sids(path, policy, &user, &mut system, &mut admins)
}

pub fn create_private_file(path: &Path, policy: WindowsAclPolicy) -> Result<File, String> {
    let (user, mut system, mut admins, mut acl_buf) = build_policy_acl(policy)?;
    let mut descriptor = SecurityDescriptor {
        revision: 0,
        reserved: 0,
        control: 0,
        owner: ptr::null_mut(),
        group: ptr::null_mut(),
        sacl: ptr::null_mut(),
        dacl: ptr::null_mut(),
    };
    let descriptor_ptr: PSECURITY_DESCRIPTOR =
        (&mut descriptor as *mut SecurityDescriptor).cast();
    // SAFETY: The descriptor and ACL are initialized, aligned, and live through `CreateFileW`.
    if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) } == 0
        || unsafe {
            SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_buf.as_mut_ptr().cast(), 0)
        } == 0
        || unsafe {
            SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
        } == 0
    {
        return Err("private-acl-unsafe: security descriptor initialization failed".to_owned());
    }
    let mut attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as DWORD,
        descriptor: descriptor_ptr,
        inherit_handle: 0,
    };
    let wname = wide(path)?;
    // SAFETY: Path and security attributes stay live for `CreateFileW`; `CREATE_NEW` cannot replace an existing file.
    let handle = unsafe {
        CreateFileW(
            wname.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_ALL,
            &mut attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle == (-1isize as HANDLE) {
        return Err(format!(
            "private-acl-unsafe: create failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `CreateFileW` returned a newly owned Win32 file handle.
    let file = unsafe { File::from_raw_handle(handle) };
    verify_with_sids(path, policy, &user, &mut system, &mut admins)?;
    Ok(file)
}

fn verify_with_sids(
    path: &Path,
    policy: WindowsAclPolicy,
    user: &[usize],
    system: &mut [u32; 17],
    admins: &mut [u32; 17],
) -> Result<(), String> {
    let wname = wide(path)?;
    let mut owner: PSID = ptr::null_mut();
    let mut dacl: PACL = ptr::null_mut();
    let mut desc: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: Reads owner + DACL into a LocalAlloc'd security descriptor freed by `Local`.
    let rc = unsafe {
        GetNamedSecurityInfoW(
            wname.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut desc,
        )
    };
    let desc = Local(desc);
    if rc != 0 || desc.0.is_null() || owner.is_null() || dacl.is_null() {
        return Err("private-acl-unsafe: GetNamedSecurityInfoW failed".to_owned());
    }
    let mut control: WORD = 0;
    let mut rev: DWORD = 0;
    let mut present: BOOL = 0;
    let mut defaulted: BOOL = 0;
    // SAFETY: Inspects valid security descriptor `desc.0` and validated `owner` / `dacl`.
    let ok = unsafe {
        GetSecurityDescriptorControl(desc.0, &mut control, &mut rev) != 0
            && GetSecurityDescriptorDacl(desc.0, &mut present, &mut dacl, &mut defaulted) != 0
            && present != 0
            && !dacl.is_null()
            && IsValidAcl(dacl) != 0
            && IsValidSid(owner) != 0
            && (EqualSid(owner, user[0] as PSID) != 0
                || (policy.allow_admin_owner
                    && EqualSid(owner, admins.as_mut_ptr().cast()) != 0))
            && (!policy.require_dacl_protected || (control & SE_DACL_PROTECTED != 0))
    };
    if !ok {
        return Err("private-acl-unsafe: DACL header/owner verification failed".to_owned());
    }
    let mut user_fc = false;
    // SAFETY: `dacl` was validated by `IsValidAcl`.
    let ace_count = unsafe { (*dacl).count } as DWORD;
    for i in 0..ace_count {
        let mut ace: LPVOID = ptr::null_mut();
        // SAFETY: `i < ace_count` inside validated `dacl`.
        if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
            return Err("private-acl-unsafe: GetAce failed".to_owned());
        }
        // SAFETY: `ace` points to a valid ACE inside `dacl`.
        let hdr = unsafe { &*ace.cast::<AceHeader>() };
        if hdr.kind != ACCESS_ALLOWED_ACE_TYPE
            || hdr.size < 16
            || (policy.require_dacl_protected && (hdr.flags & INHERITED_ACE != 0))
        {
            return Err("private-acl-unsafe: unexpected ACE kind/flags".to_owned());
        }
        // SAFETY: `ACCESS_ALLOWED_ACE` has mask at +4 and SID at +8 within `hdr.size >= 16`.
        let mask = unsafe { std::ptr::read_unaligned(ace.cast::<u8>().add(4).cast::<DWORD>()) };
        let sid = unsafe { ace.cast::<u8>().add(8).cast::<c_void>() };
        // SAFETY: Bounds-checks SID inside `hdr.size`.
        if unsafe { IsValidSid(sid) } == 0 || unsafe { GetLengthSid(sid) } + 8 > hdr.size as DWORD {
            return Err("private-acl-unsafe: invalid ACE SID".to_owned());
        }
        // SAFETY: Compares validated SIDs against user, SYSTEM, and BUILTIN\Administrators.
        let is_user = unsafe { EqualSid(sid, user[0] as PSID) } != 0;
        let is_sys = unsafe { EqualSid(sid, system.as_mut_ptr().cast()) } != 0;
        let is_adm = unsafe { EqualSid(sid, admins.as_mut_ptr().cast()) } != 0;
        if !is_user && !is_sys && !is_adm {
            return Err("private-acl-unsafe: foreign ACE present".to_owned());
        }
        user_fc |= is_user
            && (hdr.flags & INHERIT_ONLY_ACE == 0)
            && (mask & FULL_CONTROL == FULL_CONTROL || mask & GENERIC_ALL != 0);
    }
    if !user_fc {
        return Err("private-acl-unsafe: missing current-user FullControl ACE".to_owned());
    }
    Ok(())
}
