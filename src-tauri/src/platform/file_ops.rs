use std::path::Path;

/// Rename without replacing an existing directory entry. Never fall back to
/// checking existence followed by an ordinary, potentially replacing rename.
pub fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let encode = |path: &Path| -> std::io::Result<Vec<u16>> {
            let absolute = std::path::absolute(path)?;
            let mut value: Vec<u16> = absolute
                .as_os_str()
                .encode_wide()
                .map(|c| if c == b'/' as u16 { b'\\' as u16 } else { c })
                .collect();
            if value.contains(&0) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Path contains a NUL character",
                ));
            }
            // Win32 extended paths retain support for paths longer than MAX_PATH.
            // Leave existing device/verbatim prefixes unchanged.
            let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
            let device: Vec<u16> = r"\\.\".encode_utf16().collect();
            if !value.starts_with(&prefix) && !value.starts_with(&device) {
                if value.starts_with(&[b'\\' as u16, b'\\' as u16]) {
                    value = r"\\?\UNC\"
                        .encode_utf16()
                        .chain(value.into_iter().skip(2))
                        .collect();
                } else {
                    value.splice(0..0, prefix);
                }
            }
            value.push(0);
            Ok(value)
        };
        let from = encode(from)?;
        let to = encode(to)?;
        // SAFETY: both strings are NUL-terminated and remain alive for the call.
        // Flags deliberately exclude MOVEFILE_REPLACE_EXISTING and COPY_ALLOWED.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(Into::into)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (from, to);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Atomic rename without replacement is unavailable",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_preserves_existing_files_and_directories() {
        let root = std::env::temp_dir().join(format!("tunnelde-rename-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("staging");
        let target = root.join("destination");
        std::fs::write(&source, b"incoming").unwrap();
        std::fs::write(&target, b"independent").unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"incoming");
        assert_eq!(std::fs::read(&target).unwrap(), b"independent");
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert!(source.is_file());
        assert!(target.is_dir());
        std::fs::remove_dir(&target).unwrap();
        rename_noreplace(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"incoming");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rename_preserves_a_dangling_destination_symlink() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-rename-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("staging");
        let target = root.join("destination");
        std::fs::write(&source, b"incoming").unwrap();
        std::os::unix::fs::symlink(root.join("missing"), &target).unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"incoming");
        assert_eq!(std::fs::read_link(&target).unwrap(), root.join("missing"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_commits_have_only_one_winner() {
        use std::sync::{Arc, Barrier};
        let root =
            std::env::temp_dir().join(format!("tunnelde-rename-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("destination");
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .enumerate()
            .map(|(i, bytes)| {
                let source = root.join(format!("staging-{i}"));
                std::fs::write(&source, bytes).unwrap();
                let target = target.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (source.clone(), bytes, rename_noreplace(&source, &target))
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|(_, _, result)| result.is_ok())
                .count(),
            1
        );
        for (source, bytes, result) in results {
            if result.is_ok() {
                assert!(!source.exists());
                assert_eq!(std::fs::read(&target).unwrap(), bytes);
            } else {
                assert_eq!(std::fs::read(&source).unwrap(), bytes);
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rename_supports_unicode_and_long_windows_paths() {
        let root = std::env::temp_dir().join(format!("tunnelde-long-{}", uuid::Uuid::new_v4()));
        // Keep every component below the filesystem's per-component limit.
        let directory = root
            .join("long-directory-".repeat(12))
            .join("nested-".repeat(18));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("临时文件.txt");
        let target = directory.join("目标文件.txt");
        assert!(source.as_os_str().len() > 260);
        std::fs::write(&source, b"incoming").unwrap();
        rename_noreplace(&source, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"incoming");
        assert!(!source.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
