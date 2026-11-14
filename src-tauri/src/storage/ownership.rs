//! A data-home lease belongs to the application, not a webview or plugin.
//! Never unlink the sentinel: a replacement inode would split cooperating owners.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

use super::layout::Paths;
use crate::error::{AppError, AppResult};

mod resources;

pub(crate) struct Ownership {
    _resources: resources::Claim,
    _home: Lease,
}

impl Ownership {
    pub(super) fn cancel(
        &self,
        paths: &Paths,
        config: &mut super::config::Config,
    ) -> AppResult<()> {
        // A plan scheduled since startup was not in the process-lifetime claim.
        // Protect its recovery writes too, without conflicting with our own lease.
        let extra = resources::pending_roots(paths, config)?;
        let _reservation = resources::Claim::acquire(paths, &extra, Some(&self._resources))?;
        super::migration::cancel(paths, config)
    }
}

/// Keep the ordering in one entry point used by desktop startup and its tests.
pub(crate) fn initialize(
    home: std::path::PathBuf,
    logs: std::path::PathBuf,
    plugins: Option<std::path::PathBuf>,
) -> AppResult<(Paths, Ownership)> {
    std::fs::create_dir_all(&home)?;
    let lease = Lease::acquire(&home).map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            AppError::internal(
                "Another Tunnelde process is using this data directory. Quit it before starting this instance.",
            )
        } else {
            AppError::internal(format!("Cannot acquire the storage directory lease: {error}"))
        }
    })?;
    // Inspect the protected bootstrap index before migration can consume it.
    let (paths, config) = super::prepare(home, logs, plugins)?;
    let pending = resources::pending_roots(&paths, &config);
    let extra = pending.as_deref().unwrap_or_default();
    let resources = resources::Claim::acquire(&paths, extra, None)?;
    // A malformed/unavailable destination must retain the old recovery behavior:
    // report the plan error while using current data, without attempting that plan.
    let paths = super::initialize_prepared(paths, config, pending.map(|_| ()))?;
    Ok((
        paths,
        Ownership {
            _resources: resources,
            _home: lease,
        },
    ))
}

pub(super) const SENTINEL: &str = ".tunnelde-storage.lock";

pub(crate) struct Lease {
    _file: File,
    #[cfg(unix)]
    owner_pid: u32,
}

impl Lease {
    pub(crate) fn acquire(home: &Path) -> io::Result<Self> {
        Self::open(&home.join(SENTINEL), false)
    }

    fn open(path: &Path, create_new: bool) -> io::Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).truncate(false);
        if create_new {
            options.create_new(true);
        } else {
            options.create(true);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            };
            // Allow inspecting the inert sentinel, but deny writers and deletion.
            options
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path).map_err(map_busy)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || super::layout::linked(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid storage lease file",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Linked storage lease file",
                ));
            }
            rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)
                .map_err(io::Error::from)?;
        }
        Ok(Self {
            _file: file,
            #[cfg(unix)]
            owner_pid: std::process::id(),
        })
    }
}

#[cfg(unix)]
impl Drop for Lease {
    fn drop(&mut self) {
        // CLOEXEC only closes a forked child's copy after exec. Closing our file
        // alone can leave the lock alive in an unrelated child during that gap.
        // Only the acquiring process owns the lease; a forked copy must not
        // unlock its parent's live lease if it is dropped before exec.
        if self.owner_pid == std::process::id() {
            let _ = rustix::fs::flock(&self._file, rustix::fs::FlockOperation::Unlock);
        }
    }
}

fn map_busy(error: io::Error) -> io::Error {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return io::Error::new(
            io::ErrorKind::WouldBlock,
            "Storage directory is already in use",
        );
    }
    error
}

#[cfg(test)]
mod tests;
