use super::*;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::{
    Foundation::*, Security::Authorization::*, Security::*, Storage::FileSystem::*,
    System::Threading::*,
};

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let path = std::path::absolute(path)?;
    let path = if path.starts_with(r"\\?\") {
        path
    } else {
        std::fs::canonicalize(path.parent().ok_or_else(invalid)?)?
            .join(path.file_name().ok_or_else(invalid)?)
    };
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(invalid());
    }
    value.push(0);
    Ok(value)
}

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) fn private_directory(path: &Path) -> io::Result<()> {
    let mut token = std::ptr::null_mut();
    // SAFETY: valid process pseudo-handle and output storage; token is RAII-owned.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(token);
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size);
    }
    let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = Local(sid.cast());
    let mut len = 0;
    while unsafe { *sid.add(len) } != 0 {
        len += 1;
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, len) })
        .map_err(|_| invalid())?;
    drop(allocation);
    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let allocation = Local(descriptor);
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name = wide(path)?;
    // SECURITY_ATTRIBUTES applies the protected user-only DACL at creation.
    let created = unsafe { CreateDirectoryW(name.as_ptr(), &attrs) };
    drop(allocation);
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn copy_original(source: &Path, destination: &Path) -> io::Result<()> {
    let source = wide(source)?;
    let destination = wide(destination)?;
    // Fail if the private destination unexpectedly exists; never truncate it.
    if unsafe { CopyFileW(source.as_ptr(), destination.as_ptr(), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn preserve_security(source: &Path, destination: &Path) -> io::Result<()> {
    let mut descriptor = security(source)?;
    let destination = wide(destination)?;
    let mut copied = security_buffer(&destination)?;
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: both descriptors came from GetFileSecurity; output storage lives
    // through each call. EqualSid reads only the SIDs inside those descriptors.
    let mut info = DACL_SECURITY_INFORMATION;
    unsafe {
        if GetSecurityDescriptorControl(descriptor.as_mut_ptr().cast(), &mut control, &mut revision)
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        type SidGetter =
            unsafe extern "system" fn(PSECURITY_DESCRIPTOR, *mut PSID, *mut i32) -> i32;
        for (get, flag) in [
            (
                GetSecurityDescriptorOwner as SidGetter,
                OWNER_SECURITY_INFORMATION,
            ),
            (
                GetSecurityDescriptorGroup as SidGetter,
                GROUP_SECURITY_INFORMATION,
            ),
        ] {
            let mut original_sid = std::ptr::null_mut();
            let mut copied_sid = std::ptr::null_mut();
            let mut defaulted = 0;
            if get(
                descriptor.as_mut_ptr().cast(),
                &mut original_sid,
                &mut defaulted,
            ) == 0
                || get(copied.as_mut_ptr().cast(), &mut copied_sid, &mut defaulted) == 0
            {
                return Err(io::Error::last_os_error());
            }
            if original_sid.is_null()
                || copied_sid.is_null()
                || EqualSid(original_sid, copied_sid) == 0
            {
                info |= flag;
            }
        }
    }
    info |= if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    // CopyFile does not preserve the source DACL: a new file inherits from its
    // parent (our private directory). Apply the original descriptor explicitly.
    // SetFileSecurity is intentional here: unlike SetNamedSecurityInfo it does
    // not merge the staging parent's inheritable ACEs into the source ACL. The
    // original inheritance flags must survive publication into the real parent.
    // SAFETY: the path is terminated, descriptor is the self-relative descriptor
    // returned by GetFileSecurity and both buffers remain live for the call.
    if unsafe { SetFileSecurityW(destination.as_ptr(), info, descriptor.as_mut_ptr().cast()) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn security(path: &Path) -> io::Result<Vec<u8>> {
    let path = wide(path)?;
    security_buffer(&path)
}

fn security_buffer(path: &[u16]) -> io::Result<Vec<u8>> {
    let mut size = 0;
    let info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    unsafe {
        GetFileSecurityW(path.as_ptr(), info, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut bytes = vec![0; size as usize];
    if unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            info,
            bytes.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    bytes.truncate(size as usize);
    Ok(bytes)
}

pub(super) fn verify_security(source: &Path, destination: &Path) -> io::Result<()> {
    if security_contract(source)? != security_contract(destination)? {
        return Err(io::Error::other("Unable to preserve Windows file security"));
    }
    Ok(())
}

fn security_contract(path: &Path) -> io::Result<String> {
    let mut descriptor = security(path)?;
    let mut text = std::ptr::null_mut();
    // Windows resets the automatic-propagation bookkeeping bits when applying
    // a descriptor. Compare canonical owner/group/ACLs, including ACE order,
    // inherited ACE flags and inheritance protection, rather than raw storage
    // offsets or these bookkeeping bits. This changes our buffer only.
    // SAFETY: descriptor is a live self-relative descriptor; Windows allocates
    // the returned terminated UTF-16 string, which Local owns until copied.
    unsafe {
        if SetSecurityDescriptorControl(
            descriptor.as_mut_ptr().cast(),
            SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ,
            0,
        ) == 0
            || ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.as_mut_ptr().cast(),
                1,
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let allocation = Local(text.cast());
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let value =
            String::from_utf16(std::slice::from_raw_parts(text, len)).map_err(|_| invalid())?;
        drop(allocation);
        Ok(value)
    }
}
