use super::file_identity::FileIdentity;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_ID_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

pub fn identity(file: &impl AsRawHandle) -> io::Result<FileIdentity> {
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the borrowed file owns a live handle, and a successful call
    // initializes the complete information structure before it is read.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call above initialized every field.
    let info = unsafe { info.assume_init() };
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
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

impl GuardedFile {
    pub fn reader(&self) -> io::Result<File> {
        self.0.try_clone()
    }

    pub fn read(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ)
    }

    pub fn deletable(path: &Path) -> io::Result<Self> {
        Self::open(path, FILE_GENERIC_READ | DELETE)
    }

    /// Keep a staging object at its name while its existing writers run.
    /// This allows writes but rejects ordinary rename/delete/replacement.
    pub fn pin(path: &Path) -> io::Result<Self> {
        Self::open_shared(path, FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE)
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

    /// Delete the held file object. Never look the path up again after verifying it.
    /// A failure leaves the file present; dropping an uncommitted guard only unlocks it.
    pub fn delete(self) -> io::Result<()> {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle belongs to the live File; the structure matches the
        // requested information class and remains valid for the complete call.
        if unsafe {
            SetFileInformationByHandle(
                self.0.as_raw_handle(),
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
}
