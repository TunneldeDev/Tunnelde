//! Platform operations for local editor staging. No operation writes the original.
use serde::{Deserialize, Serialize};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub enum Identity {
    Windows {
        file: super::file_identity::FileIdentity,
    },
    Unix {
        device: u64,
        inode: u64,
        created_ns: Option<u64>,
    },
}

pub fn identity(file: &File) -> io::Result<Identity> {
    #[cfg(windows)]
    {
        Ok(Identity::Windows {
            file: super::guarded_file::identity(file)?,
        })
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(Identity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
            created_ns: metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|time| time.as_nanos().try_into().ok()),
        })
    }
}

/// Reject special files before opening; O_NONBLOCK/O_NOFOLLOW also close the
/// device/FIFO and final-symlink races on Unix. Canonical parent races remain OS
/// path-resolution semantics and are checked again before publication.
pub fn open_regular(path: &Path, write: bool) -> io::Result<File> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid());
    }
    identity(&file)?;
    Ok(file)
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "Expected a regular editor file",
    )
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(windows)]
    {
        windows::private_directory(path)
    }
}

pub fn directory_identity(path: &Path) -> io::Result<Identity> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        Ok(Identity::Windows {
            file: super::guarded_file::directory_identity(&file)?,
        })
    }
    #[cfg(unix)]
    {
        let file = File::open(path)?;
        if !file.metadata()?.is_dir() {
            return Err(invalid());
        }
        identity(&file)
    }
}

pub fn read_bounded(file: &mut File, maximum: u64) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn same_metadata(before: &Metadata, after: &Metadata) -> bool {
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.uid() == after.uid()
            && before.gid() == after.gid()
            && before.mode() == after.mode()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        before.file_attributes() == after.file_attributes()
            && before.creation_time() == after.creation_time()
    }
}

pub fn copy_original(
    source: &mut File,
    source_path: &Path,
    target: &Path,
    maximum: u64,
) -> io::Result<()> {
    #[cfg(windows)]
    {
        // Native copying preserves alternate streams and filesystem attributes;
        // the Windows helper also explicitly restores the original security.
        let _ = (source, maximum);
        windows::copy_original(source_path, target)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = source_path;
        let mut destination = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(target)?;
        source.seek(SeekFrom::Start(0))?;
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            unsafe extern "C" {
                fn fcopyfile(from: i32, to: i32, state: *mut std::ffi::c_void, flags: u32) -> i32;
            }
            // COPYFILE_ALL includes ACLs, stat fields, resource forks and xattrs.
            // SAFETY: both descriptors are live and the optional state is null.
            if unsafe {
                fcopyfile(
                    source.as_raw_fd(),
                    destination.as_raw_fd(),
                    std::ptr::null_mut(),
                    0xf,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            io::copy(&mut source.take(maximum + 1), &mut destination)?;
        }
        if destination.metadata()?.len() > maximum {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Editor document is too large",
            ));
        }
        destination.sync_all()
    }
}

/// Write and verify the staging file only; failure leaves the original untouched.
pub fn write_staging(file: &mut File, content: &[u8], maximum: u64) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(content)?;
    file.set_len(content.len() as u64)?;
    file.sync_all()?;
    if read_bounded(file, maximum)? != content {
        return Err(io::Error::other(
            "Staged editor content verification failed",
        ));
    }
    Ok(())
}

pub fn preserve_metadata(source: &File, destination: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = (source, destination);
        // Native CopyFile cloned the metadata before the staging content write.
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use xattr::FileExt;
        let metadata = source.metadata()?;
        let current = destination.metadata()?;
        if metadata.uid() != current.uid() || metadata.gid() != current.gid() {
            rustix::fs::fchown(
                destination,
                Some(rustix::fs::Uid::from_raw(metadata.uid())),
                Some(rustix::fs::Gid::from_raw(metadata.gid())),
            )?;
        }
        let attributes = match source.list_xattr() {
            Ok(names) => Some(
                names
                    .map(|name| {
                        source
                            .get_xattr(&name)?
                            .map(|value| (name, value))
                            .ok_or_else(|| {
                                io::Error::other("An extended attribute changed during save")
                            })
                    })
                    .collect::<io::Result<Vec<_>>>()?,
            ),
            Err(error) if error.kind() == io::ErrorKind::Unsupported => None,
            Err(error) => return Err(error),
        };
        if let Some(attributes) = &attributes {
            // A staging directory can inherit a default ACL even when the
            // original predates that ACL. Remove inherited staging-only
            // attributes, rather than accidentally publishing broader access.
            for name in destination.list_xattr()? {
                if !attributes.iter().any(|(original, _)| original == &name) {
                    destination.remove_xattr(&name)?;
                }
            }
            for (name, value) in attributes {
                if destination.get_xattr(name)?.as_ref() != Some(value) {
                    destination.set_xattr(name, value)?;
                }
            }
        }
        // Apply mode after chown and ACLs, which can change mode bits.
        if destination.metadata()?.mode() != metadata.mode() {
            destination.set_permissions(std::fs::Permissions::from_mode(metadata.mode()))?;
        }
        if let Some(attributes) = &attributes {
            for (name, value) in attributes {
                if destination.get_xattr(name)?.as_ref() != Some(value) {
                    return Err(io::Error::other(
                        "Unable to preserve editor extended attributes",
                    ));
                }
            }
        }
        let copied = destination.metadata()?;
        if copied.mode() != metadata.mode()
            || copied.uid() != metadata.uid()
            || copied.gid() != metadata.gid()
        {
            return Err(io::Error::other(
                "Unable to preserve editor file permissions",
            ));
        }
        destination.sync_all()
    }
}

pub fn preserve_security(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        windows::preserve_security(source, target)
    }
    #[cfg(unix)]
    {
        let _ = (source, target);
        Ok(())
    }
}

pub fn verify_security(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        windows::verify_security(source, target)
    }
    #[cfg(unix)]
    {
        let _ = (source, target);
        Ok(())
    }
}

pub fn publish(staging: &Path, destination: &Path, expected: &Identity) -> io::Result<()> {
    #[cfg(windows)]
    {
        let held = super::guarded_file::GuardedFile::deletable(staging)?;
        if (Identity::Windows {
            file: held.identity()?,
        }) != *expected
        {
            return Err(invalid());
        }
        held.rename_replace(destination)
    }
    #[cfg(unix)]
    {
        let held = open_regular(staging, false)?;
        if identity(&held)? != *expected {
            return Err(invalid());
        }
        std::fs::rename(staging, destination)
    }
}

#[cfg(windows)]
mod windows;
