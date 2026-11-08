use super::file_identity::FileIdentity;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileIdInfo, FileRenameInfo, FileRenameInfoEx, GetFileInformationByHandle,
    GetFileInformationByHandleEx, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_ID_INFO, FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::WindowsProgramming::{
    FILE_RENAME_FLAG_POSIX_SEMANTICS, FILE_RENAME_FLAG_REPLACE_IF_EXISTS,
};

pub fn identity(file: &impl AsRawHandle) -> io::Result<FileIdentity> {
    object_identity(file, false)
}

pub fn directory_identity(file: &impl AsRawHandle) -> io::Result<FileIdentity> {
    object_identity(file, true)
}

fn object_identity(file: &impl AsRawHandle, directory: bool) -> io::Result<FileIdentity> {
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the borrowed file owns a live handle, and a successful call
    // initializes the complete information structure before it is read.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call above initialized every field.
    let info = unsafe { info.assume_init() };
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a regular file",
        ));
    }
    // ReFS requires the complete 128-bit identifier. The older 64-bit file index
    // cannot reliably distinguish objects on every supported Windows filesystem.
    let mut id = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: the handle is live and the buffer has the requested structure's size.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            id.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call above initialized every field.
    let id = unsafe { id.assume_init() };
    if id.FileId.Identifier == [0; 16] {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Filesystem returned no file identifier",
        ));
    }
    Ok(FileIdentity::Windows {
        volume: id.VolumeSerialNumber,
        index: id.FileId.Identifier,
        created: (u64::from(info.ftCreationTime.dwHighDateTime) << 32)
            | u64::from(info.ftCreationTime.dwLowDateTime),
    })
}

/// Hold a regular Windows file against ordinary writes, renames and deletion.
/// Sharing is checked in both directions: an already open writer makes acquisition
/// fail, rather than allowing verification against a file that can still change.
pub struct GuardedFile(File);

/// Pin a directory itself, without claiming its children cannot change. Every
/// ancestor must stay pinned while a caller uses a descendant's absolute path.
pub struct GuardedDirectory(File);

impl GuardedDirectory {
    pub fn pin(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ)
    }

    pub fn deletable(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ | DELETE)
    }

    fn open(path: &Path, access: u32) -> io::Result<Self> {
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        directory_identity(&file)?;
        Ok(Self(file))
    }

    pub fn identity(&self) -> io::Result<FileIdentity> {
        directory_identity(&self.0)
    }

    /// The filesystem rejects nonempty directories atomically. Never recurse:
    /// newly inserted or unplanned children must remain with their source.
    pub fn delete(self) -> io::Result<()> {
        delete_object(&self.0)
    }
}

fn delete_object(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: the live file owns the handle, and the buffer matches this class.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl GuardedFile {
    pub fn reader(&self) -> io::Result<File> {
        self.0.try_clone()
    }

    pub fn read(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ)
    }

    /// A verified move must flush the completed destination before deleting its
    /// source. Windows requires write access for FlushFileBuffers/sync_all.
    pub fn syncable(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ | FILE_GENERIC_WRITE)
    }

    pub fn deletable(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ | DELETE)
    }

    /// Keep a staging object at its name while its existing writers run.
    /// This allows writes but rejects ordinary rename/delete/replacement.
    pub fn pin(path: &Path) -> io::Result<Self> {
        Self::open_shared(
            path,
            FILE_GENERIC_READ | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )
    }

    pub fn identity(&self) -> io::Result<FileIdentity> {
        identity(&self.0)
    }

    fn open(path: &Path, access: u32) -> io::Result<Self> {
        Self::open_shared(path, access, FILE_SHARE_READ)
    }

    fn open_shared(path: &Path, access: u32, sharing: u32) -> io::Result<Self> {
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(sharing)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Expected a regular file without a reparse point",
            ));
        }
        Ok(Self(file))
    }

    /// Publish the held object without unlocking it or looking its source path up
    /// again. Never replace a destination created by another operation.
    pub fn rename_noreplace(&self, to: &Path) -> io::Result<()> {
        self.rename(to, false)
    }

    /// Atomic editor publication. Callers separately verify the existing target;
    /// this operation never truncates or looks up the held staging source again.
    pub fn rename_replace(&self, to: &Path) -> io::Result<()> {
        self.rename(to, true)
    }

    fn rename(&self, to: &Path, replace: bool) -> io::Result<()> {
        let to = std::path::absolute(to)?;
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "Expected a file destination");
        let leaf = to.file_name().ok_or_else(invalid)?;
        if leaf.encode_wide().any(|c| c == b':' as u16) {
            return Err(invalid());
        }
        let mut name: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .map(|c| if c == b'/' as u16 { b'\\' as u16 } else { c })
            .collect();
        if name.is_empty() || name.contains(&0) {
            return Err(invalid());
        }
        // Use the verbatim prefix for long paths. The source remains identified
        // by its held handle; destination parent path resolution is separate.
        let verbatim: Vec<u16> = r"\\?\".encode_utf16().collect();
        let device: Vec<u16> = r"\\.\".encode_utf16().collect();
        if !name.starts_with(&verbatim) && !name.starts_with(&device) {
            if name.starts_with(&[b'\\' as u16, b'\\' as u16]) {
                let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
                name.splice(0..2, unc);
            } else {
                name.splice(0..0, verbatim);
            }
        }
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let bytes = offset + std::mem::size_of_val(name.as_slice());
        // usize storage provides the header's pointer alignment, with enough
        // space for its variable-length UTF-16 filename and a trailing zero.
        let allocated = (bytes + 2).max(std::mem::size_of::<FILE_RENAME_INFO>());
        let mut storage = vec![0usize; allocated.div_ceil(std::mem::size_of::<usize>())];
        let header = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: storage is aligned and large enough for the header and name.
        // The caller chooses replacement explicitly. The source file handle
        // remains live for the call; the destination name is absolute.
        unsafe {
            (*header).Anonymous.Flags = if replace {
                // Keep existing readers on the old object, including our own
                // write-denying verification handle, while atomically replacing
                // its directory entry. Requires supported Windows/filesystem
                // semantics; failure must never fall back to truncation.
                FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS
            } else {
                0
            };
            (*header).RootDirectory = std::ptr::null_mut();
            (*header).FileNameLength =
                u32::try_from(std::mem::size_of_val(name.as_slice())).map_err(|_| invalid())?;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                name.len(),
            );
            if SetFileInformationByHandle(
                self.0.as_raw_handle(),
                if replace {
                    FileRenameInfoEx
                } else {
                    FileRenameInfo
                },
                header.cast(),
                u32::try_from(bytes).map_err(|_| invalid())?,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// Delete the held file object. Never look the path up again after verifying it.
    /// A failure leaves the file present; dropping an uncommitted guard only unlocks it.
    pub fn delete(self) -> io::Result<()> {
        delete_object(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("tunnelde-file-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn guarded_file_blocks_writes_and_replacement_until_handle_deletion() {
        let root = root();
        let path = root.join("source");
        let other = root.join("replacement");
        std::fs::write(&path, b"verified contents").unwrap();
        std::fs::write(&other, b"independent contents").unwrap();
        let guard = GuardedFile::deletable(&path).unwrap();
        assert!(std::fs::write(&path, b"changed").is_err());
        assert!(std::fs::rename(&path, root.join("moved")).is_err());
        assert!(std::fs::rename(&other, &path).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"verified contents");
        guard.delete().unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read(&other).unwrap(), b"independent contents");
        std::fs::remove_file(other).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn guarded_file_rejects_existing_writer_and_releases_without_deleting() {
        let root = root();
        let path = root.join("source");
        std::fs::write(&path, b"original").unwrap();
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        assert!(GuardedFile::deletable(&path).is_err());
        assert!(GuardedFile::read(&path).is_err());
        drop(writer);
        let guard = GuardedFile::read(&path).unwrap();
        assert!(std::fs::write(&path, b"changed").is_err());
        drop(guard);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::write(&path, b"changed").unwrap();
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn guarded_file_never_opens_directories_or_deletes_with_a_read_handle() {
        let root = root();
        assert!(GuardedFile::read(&root).is_err());
        let path = root.join("source");
        std::fs::write(&path, b"preserved").unwrap();
        assert!(GuardedFile::read(&path).unwrap().delete().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"preserved");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn pinned_staging_publishes_the_same_object_without_unlocking_or_overwriting() {
        let root = root();
        let stage = root.join("stage");
        let target = root.join("target");
        let competitor = root.join("competitor");
        std::fs::write(&stage, b"incoming").unwrap();
        std::fs::write(&target, b"independent").unwrap();
        std::fs::write(&competitor, b"unrelated").unwrap();
        let pin = GuardedFile::pin(&stage).unwrap();
        let expected = pin.identity().unwrap();
        assert!(std::fs::rename(&competitor, &stage).is_err());
        assert!(std::fs::remove_file(&stage).is_err());
        assert!(pin.rename_noreplace(&target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"independent");
        assert_eq!(pin.identity().unwrap(), expected);
        std::fs::remove_file(&target).unwrap();
        pin.rename_noreplace(&target).unwrap();
        assert!(!stage.exists());
        let published = identity(&File::open(&target).unwrap()).unwrap();
        // NTFS filename tunneling may restore a previous destination's creation
        // time on rename. The volume and file ID still identify the held object.
        let FileIdentity::Windows { volume, index, .. } = expected;
        assert!(
            matches!(published, FileIdentity::Windows { volume: v, index: i, .. } if v == volume && i == index)
        );
        assert_eq!(pin.identity().unwrap(), published);
        assert_eq!(std::fs::read(&target).unwrap(), b"incoming");
        assert!(std::fs::remove_file(&target).is_err());
        assert!(std::fs::rename(&competitor, &target).is_err());
        drop(pin);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_staging_commit_rejects_directory_targets_and_read_only_handles() {
        let root = root();
        let stage = root.join("stage");
        let directory = root.join("directory");
        let target = root.join("completed");
        std::fs::write(&stage, b"incoming").unwrap();
        std::fs::create_dir(&directory).unwrap();
        let read = GuardedFile::read(&stage).unwrap();
        assert!(read.rename_noreplace(&target).is_err());
        drop(read);
        let pin = GuardedFile::pin(&stage).unwrap();
        assert!(pin.rename_noreplace(&directory).is_err());
        assert!(directory.is_dir());
        assert_eq!(std::fs::read(&stage).unwrap(), b"incoming");
        let slash_target = target.to_string_lossy().replace('\\', "/");
        pin.rename_noreplace(Path::new(&slash_target)).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"incoming");
        drop(pin);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_staging_rename_supports_long_unicode_paths_and_preserves_missing_parent() {
        let root = root();
        let directory = root
            .join("long-directory-".repeat(12))
            .join("nested-".repeat(18));
        std::fs::create_dir_all(&directory).unwrap();
        let stage = directory.join("暂存文件.txt");
        let target = directory.join("完成文件.txt");
        std::fs::write(&stage, b"contents").unwrap();
        let pin = GuardedFile::pin(&stage).unwrap();
        assert!(pin
            .rename_noreplace(&directory.join("missing/file"))
            .is_err());
        assert!(pin
            .rename_noreplace(&directory.join("stream:unsafe"))
            .is_err());
        assert_eq!(std::fs::read(&stage).unwrap(), b"contents");
        pin.rename_noreplace(&target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"contents");
        drop(pin);
        std::fs::remove_dir_all(root).unwrap();
    }
}
