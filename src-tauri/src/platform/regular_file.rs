//! Read-only regular handles; caller resolves intentional aliases before opening.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

pub fn open_read(path: &Path) -> io::Result<File> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    open_handle(path)
}

// The flags and handle check are necessary even after the earlier metadata check.
// Ancestor path resolution still follows the OS; this is not a directory sandbox.
fn open_handle(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        // Readers must still work on a log held open by its writer.
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::*;
        // SAFETY: the borrowed file owns a live handle for this synchronous call.
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || unsafe { GetFileType(file.as_raw_handle().cast()) } != FILE_TYPE_DISK
        {
            return Err(invalid());
        }
    }
    Ok(file)
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "Expected a regular readable file",
    )
}

#[cfg(test)]
mod tests;
