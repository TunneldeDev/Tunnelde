//! Bounded import and staged export; filesystem I/O runs outside the async runtime.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::{parse_document, SettingsDocument, MAX_FILE_BYTES};
use crate::error::{AppError, AppResult};

pub(super) fn read(path: &Path) -> AppResult<SettingsDocument> {
    // Windows cannot open directories with ordinary File options. Check first
    // for a useful error, then check the opened handle again before reading.
    if !std::fs::metadata(path)?.is_file() {
        return Err(AppError::validation("profiles.notRegularFile"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A selected FIFO must not wait for a writer before the type check.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::validation("profiles.notRegularFile"));
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(AppError::validation("profiles.tooLarge"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::validation("profiles.tooLarge"));
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| AppError::validation("profiles.invalidFile"))?;
    parse_document(text.strip_prefix('\u{feff}').unwrap_or(text))
}

pub(super) fn write(target: &Path, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::validation("profiles.tooLarge"));
    }
    write_with(target, |file| file.write_all(bytes))
}

struct TemporaryExport(PathBuf);

impl Drop for TemporaryExport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_with(
    target: &Path,
    writer: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> AppResult<()> {
    let parent = target
        .parent()
        .filter(|_| target.file_name().is_some())
        .ok_or_else(|| AppError::validation("profiles.notRegularFile"))?;
    let existing = match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Some(metadata),
        Ok(_) => return Err(AppError::validation("profiles.notRegularFile")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if existing
        .as_ref()
        .is_some_and(|metadata| metadata.permissions().readonly())
    {
        return Err(AppError::validation("profiles.readOnlyFile"));
    }
    let temporary = parent.join(format!(".tunnelde-settings-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    // Only remove a file this invocation successfully created.
    let temporary = TemporaryExport(temporary);
    writer(&mut file)?;
    if let Some(existing) = existing {
        file.set_permissions(existing.permissions())?;
    }
    file.sync_all()?;
    drop(file);
    // A same-directory rename publishes a complete file. A write/sync/rename
    // failure leaves the selected export intact and Drop removes our staging.
    std::fs::rename(&temporary.0, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("tunnelde-profile-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn document() -> Vec<u8> {
        br#"{"format":"tunnelde-settings","version":1,"name":"Work","settings":{"theme":"dark"}}"#
            .to_vec()
    }

    #[test]
    fn failed_write_never_truncates_an_existing_export_and_cleans_its_temporary() {
        let fixture = Fixture::new();
        let target = fixture.0.join("settings.json");
        std::fs::write(&target, b"original exported settings").unwrap();
        let failure = write_with(&target, |file| {
            file.write_all(b"{ partial export")?;
            Err(std::io::Error::other("simulated full disk"))
        });
        assert!(failure.is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"original exported settings"
        );
        assert_eq!(fixture.names(), ["settings.json"]);
    }

    #[test]
    fn failed_new_export_and_publication_do_not_leave_partial_files() {
        let fixture = Fixture::new();
        let target = fixture.0.join("settings.json");
        assert!(write_with(&target, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("simulated interrupted write"))
        })
        .is_err());
        assert!(fixture.names().is_empty());
        assert!(write_with(&target, |file| {
            file.write_all(&document())?;
            // Another operation creates a directory while the export is writing.
            std::fs::create_dir(&target)?;
            Ok(())
        })
        .is_err());
        assert!(target.is_dir());
        assert_eq!(fixture.names(), ["settings.json"]);
    }

    #[test]
    fn exported_unicode_paths_replace_complete_documents_and_round_trip() {
        let fixture = Fixture::new();
        let target = fixture.0.join("工作设置.json");
        write(&target, b"old export").unwrap();
        write(&target, &document()).unwrap();
        let imported = read(&target).unwrap();
        assert_eq!(imported.name, "Work");
        assert_eq!(imported.settings["theme"], "dark");
        assert_eq!(fixture.names(), ["工作设置.json"]);
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(document());
        std::fs::write(&target, bom).unwrap();
        assert_eq!(read(&target).unwrap().name, "Work");
    }

    #[test]
    fn oversize_and_invalid_utf8_imports_are_actionable_and_never_change_preferences() {
        let fixture = Fixture::new();
        let target = fixture.0.join("settings.json");
        std::fs::write(&target, [0xff, 0xfe]).unwrap();
        assert_eq!(
            read(&target).err().unwrap().to_string(),
            "profiles.invalidFile"
        );
        std::fs::write(&target, vec![b' '; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            read(&target).err().unwrap().to_string(),
            "profiles.tooLarge"
        );
        assert_eq!(
            write(&target, &vec![b' '; MAX_FILE_BYTES + 1])
                .err()
                .unwrap()
                .to_string(),
            "profiles.tooLarge"
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            (MAX_FILE_BYTES + 1) as u64
        );
    }

    #[test]
    fn directories_and_read_only_exports_are_rejected_without_mutation() {
        let fixture = Fixture::new();
        assert_eq!(
            read(&fixture.0).err().unwrap().to_string(),
            "profiles.notRegularFile"
        );
        assert_eq!(
            write(&fixture.0, &document()).err().unwrap().to_string(),
            "profiles.notRegularFile"
        );
        let target = fixture.0.join("settings.json");
        std::fs::write(&target, b"protected settings").unwrap();
        let original = std::fs::metadata(&target).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&target, readonly).unwrap();
        let result = write(&target, &document());
        let unchanged = std::fs::read(&target).unwrap();
        std::fs::set_permissions(&target, original).unwrap();
        assert!(result.is_err());
        assert_eq!(unchanged, b"protected settings");
        assert_eq!(fixture.names(), ["settings.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_import_rejects_a_fifo_without_waiting_for_a_writer() {
        use std::process::{Command, Stdio};
        // Run in a separate process so a regression can be killed instead of
        // hanging the suite on an unbounded FIFO open.
        const VARIABLE: &str = "TUNNELDE_QA_PROFILE_FIFO";
        if let Some(path) = std::env::var_os(VARIABLE) {
            assert_eq!(
                read(Path::new(&path)).err().unwrap().to_string(),
                "profiles.notRegularFile"
            );
            return;
        }
        let fixture = Fixture::new();
        let fifo = fixture.0.join("settings.json");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("settings_profiles::files::tests::unix_import_rejects_a_fifo_without_waiting_for_a_writer")
            .arg("--exact")
            .env(VARIABLE, &fifo)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("Import blocked waiting for a FIFO writer");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_export_preserves_existing_permissions_and_protects_new_exports() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = Fixture::new();
        let target = fixture.0.join("settings.json");
        write(&target, &document()).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        write(&target, &document()).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let alias = fixture.0.join("alias.json");
        symlink(&target, &alias).unwrap();
        assert_eq!(
            write(&alias, b"replacement").err().unwrap().to_string(),
            "profiles.notRegularFile"
        );
        assert_eq!(read(&alias).unwrap().name, "Work");
        assert_eq!(std::fs::read(&target).unwrap(), document());
    }
}
