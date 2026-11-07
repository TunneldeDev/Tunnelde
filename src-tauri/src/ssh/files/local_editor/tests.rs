use super::*;
use std::io::{Seek, SeekFrom};

struct Fixture {
    root: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-local-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("note.txt");
        std::fs::write(&file, "original").unwrap();
        Self { root, file }
    }
    fn save(&self, content: &str, baseline: &str) -> AppResult<()> {
        save_sync(
            None,
            &display_path(&self.file),
            content,
            baseline,
            |_, _| Ok(()),
        )
    }
    fn disk(&self) -> String {
        std::fs::read_to_string(&self.file).unwrap()
    }
    fn clean(&self) {
        assert_eq!(std::fs::read_dir(&self.root).unwrap().count(), 1);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Ok(metadata) = self.file.metadata() {
            let mut permissions = metadata.permissions();
            // This block is Windows-only: clearing its readonly attribute does
            // not broaden Unix mode bits.
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(&self.file, permissions);
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn legacy_plugin_save_uses_an_atomic_snapshot_and_explicit_baseline_detects_conflicts() {
    let f = Fixture::new();
    save_transaction(
        None,
        &display_path(&f.file),
        "draft",
        None,
        |_, original| {
            assert_eq!(original, "original");
            Ok(())
        },
        |phase, _| {
            if phase != "published" {
                assert_eq!(f.disk(), "original");
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(f.disk(), "draft");
    f.clean();
    let result = save_transaction(
        None,
        &display_path(&f.file),
        "new draft",
        Some("original"),
        |_, _| Ok(()),
        |_, _| Ok(()),
    );
    assert_eq!(result.unwrap_err().to_string(), "editor.localFileChanged");
    assert_eq!(f.disk(), "draft");
    f.clean();
}

#[test]
fn guarded_save_authorizes_noops_and_rechecks_after_staging_without_losing_original() {
    use std::cell::Cell;
    let f = Fixture::new();
    for content in ["original", "draft"] {
        let result = save_transaction(
            None,
            &display_path(&f.file),
            content,
            None,
            |_, _| Err(AppError::validation("test.revoked")),
            |_, _| panic!("unauthorized save created staging"),
        );
        assert_eq!(result.unwrap_err().to_string(), "test.revoked");
        assert_eq!(f.disk(), "original");
        f.clean();
    }
    let verified = Cell::new(false);
    let checks = Cell::new(0);
    let result = save_transaction(
        None,
        &display_path(&f.file),
        "draft",
        None,
        |_, original| {
            checks.set(checks.get() + 1);
            assert_eq!(original, "original");
            if verified.get() {
                Err(AppError::validation("test.revoked"))
            } else {
                Ok(())
            }
        },
        |phase, _| {
            if phase == "verified" {
                verified.set(true);
            }
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().to_string(), "test.revoked");
    assert_eq!(checks.get(), 2);
    assert_eq!(f.disk(), "original");
    f.clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_an_in_progress_async_save_refuses_publication_and_cleans_staging() {
    let f = Fixture::new();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (release, blocker) = std::sync::mpsc::channel();
    let blocker = Mutex::new(blocker);
    let save = tokio::spawn(save_async(
        None,
        display_path(&f.file),
        "draft".into(),
        None,
        move |_, _| {
            if let Some(entered) = entered.lock().unwrap().take() {
                let _ = entered.send(());
                blocker
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
            }
            Ok(())
        },
    ));
    tokio::time::timeout(std::time::Duration::from_secs(10), waiting)
        .await
        .unwrap()
        .unwrap();
    let lock = lock_for(&std::fs::canonicalize(&f.file).unwrap());
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    // The blocking worker must finish its cleanup before the assertion. Taking
    // the same path lock waits for that real worker rather than guessing a delay.
    tokio::task::spawn_blocking(move || drop(lock.lock().unwrap()))
        .await
        .unwrap();
    assert_eq!(f.disk(), "original");
    f.clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_a_queued_async_save_does_not_publish_when_the_lock_becomes_available() {
    let f = Fixture::new();
    let path = std::fs::canonicalize(&f.file).unwrap();
    let lock = lock_for(&path);
    let held_lock = lock.clone();
    let (ready, acquired) = std::sync::mpsc::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _held = held_lock.lock().unwrap();
        ready.send(()).unwrap();
        blocked
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
    });
    acquired
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let checked = called.clone();
    let mut save = Box::pin(save_async(
        None,
        display_path(&f.file),
        "draft".into(),
        None,
        move |_, _| {
            checked.store(true, Ordering::Release);
            Ok(())
        },
    ));
    // Poll the real future once, dispatching its blocking worker behind the lock.
    assert!(matches!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(std::future::Future::poll(
            save.as_mut(),
            cx
        )))
        .await,
        std::task::Poll::Pending
    ));
    for _ in 0..100 {
        if Arc::strong_count(&lock) == 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        Arc::strong_count(&lock),
        3,
        "blocking worker did not reach path lock"
    );
    drop(save);
    release.send(()).unwrap();
    holder.join().unwrap();
    // All blocking work must drain before inspecting the fixture (including a
    // worker not yet scheduled when the lock was released).
    for _ in 0..100 {
        if Arc::strong_count(&lock) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        Arc::strong_count(&lock),
        1,
        "blocking worker did not finish"
    );
    assert!(!called.load(Ordering::Acquire));
    assert_eq!(f.disk(), "original");
    f.clean();
}

#[test]
fn cleanup_identities_remain_readable_when_a_profile_moves_between_platforms() {
    for json in [
        serde_json::json!({"platform":"unix","device":1,"inode":2,"created_ns":3}),
        serde_json::json!({"platform":"windows","file":{"platform":"windows","volume":1,"index":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"created":2}}),
    ] {
        let identity: Identity = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(identity).unwrap(), json);
    }
}

#[test]
fn saves_short_empty_unicode_and_bom_crlf_without_changing_original_until_commit() {
    let f = Fixture::new();
    let mut baseline = "original".to_string();
    for content in ["短\r\n", "", "\u{feff}new\r\n", &"界".repeat(30000)] {
        let before = baseline.clone();
        save_sync(
            None,
            &display_path(&f.file),
            content,
            &baseline,
            |phase, _| {
                if phase != "published" {
                    assert_eq!(f.disk(), before);
                }
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(f.disk(), content);
        f.clean();
        baseline = content.into();
    }
}

#[test]
fn write_sync_verification_and_publication_failures_never_modify_original() {
    for phase in ["copied", "staged", "verified"] {
        let f = Fixture::new();
        let result = save_sync(
            None,
            &display_path(&f.file),
            "draft",
            "original",
            |at, record| {
                if at == phase {
                    if at == "copied" {
                        // Model an actual partial staging write, followed by disk-full.
                        let mut file =
                            native::open_regular(&record.directory.join("content"), true)?;
                        file.seek(SeekFrom::Start(0))?;
                        file.write_all(b"half")?;
                    }
                    return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
                }
                Ok(())
            },
        );
        assert!(result.is_err(), "{phase}");
        assert_eq!(f.disk(), "original");
        f.clean();
    }
}

#[test]
fn detects_external_edits_and_does_not_recreate_deleted_files() {
    let f = Fixture::new();
    assert_eq!(
        f.save("draft", "wrong baseline").unwrap_err().to_string(),
        "editor.localFileChanged"
    );
    assert_eq!(f.disk(), "original");
    f.clean();
    std::fs::remove_file(&f.file).unwrap();
    assert!(f.save("draft", "original").is_err());
    assert!(!f.file.exists());
}

#[test]
fn rejects_target_replacement_during_staging_even_when_bytes_match() {
    let f = Fixture::new();
    let replaced = f.root.join("old-file");
    let result = save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, _| {
            if phase == "staged" {
                std::fs::rename(&f.file, &replaced)?;
                std::fs::write(&f.file, "original")?;
            }
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().to_string(), "editor.localFileChanged");
    assert_eq!(f.disk(), "original");
    assert_eq!(std::fs::read_to_string(replaced).unwrap(), "original");
    assert!(!std::fs::read_dir(&f.root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".tunnelde-save-")));
}

#[test]
fn readonly_original_and_special_paths_are_not_saved() {
    let f = Fixture::new();
    let mut permissions = f.file.metadata().unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&f.file, permissions).unwrap();
    assert!(f.save("draft", "original").is_err());
    assert_eq!(f.disk(), "original");
    f.clean();
    assert!(save_sync(
        None,
        &display_path(&f.root),
        "draft",
        "original",
        |_, _| Ok(())
    )
    .is_err());
}

#[test]
fn cleanup_after_interrupted_save_checks_saved_identity_and_marker() {
    let f = Fixture::new();
    let mut saved = None;
    // A fresh unexpected child deliberately prevents the ordinary error cleanup.
    assert!(save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, record| {
            if phase == "staged" {
                std::fs::write(record.directory.join("independent"), "leave this file")?;
                saved = Some(serde_json::to_string(record)?);
                return Err(AppError::internal("interrupted"));
            }
            Ok(())
        }
    )
    .is_err());
    assert_eq!(f.disk(), "original");
    let mut record: Record = serde_json::from_str(saved.as_ref().unwrap()).unwrap();
    assert_eq!(
        cleanup(&mut record, |_| Ok(())).unwrap_err().to_string(),
        "editor.cleanupUnrecognized"
    );
    assert_eq!(
        std::fs::read_to_string(record.directory.join("independent")).unwrap(),
        "leave this file"
    );
    std::fs::remove_file(record.directory.join("independent")).unwrap();
    let staging = record.directory.join("content");
    let original_stage = record.directory.join("stage-kept-open");
    std::fs::rename(&staging, &original_stage).unwrap();
    std::fs::write(&staging, "independent replacement").unwrap();
    std::fs::remove_file(original_stage).unwrap();
    assert!(cleanup(&mut record, |_| Ok(())).is_err());
    assert_eq!(
        std::fs::read_to_string(&staging).unwrap(),
        "independent replacement"
    );
    // Remove only our test replacement, then retry the original journal entry.
    std::fs::remove_file(staging).unwrap();
    cleanup(&mut record, |_| Ok(())).unwrap();
    f.clean();
}

#[test]
fn failed_cleanup_checkpoint_keeps_ownership_marker_and_retry_cleans_only_staging() {
    let f = Fixture::new();
    let mut saved = None;
    f.save("before", "original").unwrap();
    assert!(save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "before",
        |phase, record| {
            if phase == "published" {
                std::fs::write(record.directory.join("independent"), "fixture")?;
                saved = Some(serde_json::to_string(record)?);
                return Err(AppError::internal("lost completion"));
            }
            Ok(())
        }
    )
    .is_err());
    assert_eq!(f.disk(), "draft");
    let mut record: Record = serde_json::from_str(saved.as_ref().unwrap()).unwrap();
    std::fs::remove_file(record.directory.join("independent")).unwrap();
    assert!(cleanup(&mut record, |_| Err(AppError::internal(
        "journal unavailable"
    )))
    .is_err());
    assert!(record.directory.join("owner").exists());
    let mut recovered: Record =
        serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
    cleanup(&mut recovered, |_| Ok(())).unwrap();
    assert_eq!(f.disk(), "draft");
    f.clean();
}

#[test]
fn changing_a_staging_directory_to_a_different_object_is_not_cleaned() {
    let f = Fixture::new();
    let mut saved = None;
    assert!(save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, record| {
            if phase == "staged" {
                std::fs::write(record.directory.join("independent"), "fixture")?;
                saved = Some(record.clone());
                return Err(AppError::internal("interrupted"));
            }
            Ok(())
        }
    )
    .is_err());
    let mut record = saved.unwrap();
    let displaced = f.root.join("preserved-stage");
    std::fs::rename(&record.directory, &displaced).unwrap();
    std::fs::create_dir(&record.directory).unwrap();
    assert!(cleanup(&mut record, |_| Ok(())).is_err());
    assert!(record.directory.is_dir());
    assert_eq!(f.disk(), "original");
}

#[test]
fn concurrent_saves_serialize_and_one_stale_baseline_is_rejected() {
    let f = Fixture::new();
    let path = display_path(&f.file);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|content| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                save_sync(None, &path, content, "original", |_, _| Ok(()))
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(matches!(f.disk().as_str(), "first" | "second"));
    f.clean();
}

#[cfg(unix)]
#[test]
fn unix_saves_preserve_mode_owner_extended_attributes_and_symlinks() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let f = Fixture::new();
    std::fs::set_permissions(&f.file, std::fs::Permissions::from_mode(0o750)).unwrap();
    xattr::set(&f.file, "user.tunnelde-test", b"extended metadata").unwrap();
    let metadata = f.file.metadata().unwrap();
    let link = f.root.join("alias");
    symlink(&f.file, &link).unwrap();
    save_sync(None, &display_path(&link), "draft", "original", |_, _| {
        Ok(())
    })
    .unwrap();
    let current = f.file.metadata().unwrap();
    assert_eq!(current.mode(), metadata.mode());
    assert_eq!(current.uid(), metadata.uid());
    assert_eq!(current.gid(), metadata.gid());
    assert_eq!(
        xattr::get(&f.file, "user.tunnelde-test").unwrap().unwrap(),
        b"extended metadata"
    );
    assert!(std::fs::symlink_metadata(link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(f.disk(), "draft");
}

#[cfg(unix)]
#[test]
fn unix_staging_catches_writes_and_symlink_retargeting_during_save() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    assert_eq!(
        save_sync(
            None,
            &display_path(&f.file),
            "draft",
            "original",
            |phase, _| {
                if phase == "staged" {
                    std::fs::write(&f.file, "external")?;
                }
                Ok(())
            }
        )
        .unwrap_err()
        .to_string(),
        "editor.localFileChanged"
    );
    assert_eq!(f.disk(), "external");
    let other = f.root.join("other");
    std::fs::write(&other, "other preserved").unwrap();
    let link = f.root.join("link");
    symlink(&f.file, &link).unwrap();
    assert_eq!(
        save_sync(
            None,
            &display_path(&link),
            "draft",
            "external",
            |phase, _| {
                if phase == "staged" {
                    std::fs::remove_file(&link)?;
                    symlink(&other, &link)?;
                }
                Ok(())
            }
        )
        .unwrap_err()
        .to_string(),
        "editor.localFileChanged"
    );
    assert_eq!(std::fs::read_to_string(other).unwrap(), "other preserved");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_save_does_not_publish_an_acl_inherited_only_by_staging() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    assert!(xattr::get(&f.file, "system.posix_acl_access")
        .unwrap()
        .is_none());
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, id) in [
        (1u16, 7u16, u32::MAX),
        (2, 4, f.file.metadata().unwrap().uid().wrapping_add(12345)),
        (4, 4, u32::MAX),
        (16, 4, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(id.to_le_bytes());
    }
    xattr::set(&f.root, "system.posix_acl_default", &acl).unwrap();
    let mut inherited = false;
    save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, record| {
            if phase == "copied" {
                inherited =
                    xattr::get(record.directory.join("content"), "system.posix_acl_access")?
                        .is_some();
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(inherited);
    assert_eq!(f.disk(), "draft");
    assert!(xattr::get(&f.file, "system.posix_acl_access")
        .unwrap()
        .is_none());
    f.clean();
}

#[cfg(windows)]
#[test]
fn windows_saves_preserve_security_alternate_streams_and_hidden_attribute() {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::*;
    let f = Fixture::new();
    let ads = format!("{}:tunnelde-test", f.file.display());
    std::fs::write(&ads, "alternate stream").unwrap();
    let mut wide: Vec<u16> = f.file.as_os_str().encode_wide().collect();
    wide.push(0);
    unsafe {
        assert_ne!(SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN), 0);
    }
    let reference = f.root.join("security-reference");
    let mut source = native::open_regular(&f.file, false).unwrap();
    native::copy_original(&mut source, &f.file, &reference, MAX_TEXT).unwrap();
    drop(source);
    native::preserve_security(&f.file, &reference).unwrap();
    f.save("draft", "original").unwrap();
    native::verify_security(&reference, &f.file).unwrap();
    assert_eq!(std::fs::read_to_string(ads).unwrap(), "alternate stream");
    assert_ne!(
        f.file.metadata().unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN,
        0
    );
    // Windows deny-write sharing prevents another writer during staging.
    save_sync(
        None,
        &display_path(&f.file),
        "second",
        "draft",
        |phase, _| {
            if phase == "staged" {
                assert!(File::options()
                    .write(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                    .open(&f.file)
                    .is_err());
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(f.disk(), "second");
    native::verify_security(&reference, &f.file).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_actual_publication_failure_preserves_original_and_cleans_staging() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::*;
    let f = Fixture::new();
    // An ordinary reader that permits writes but denies deletion allows staging
    // and verification, then makes the real atomic publication fail.
    let reader = File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&f.file)
        .unwrap();
    let mut verified = false;
    assert!(save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, _| {
            if phase == "verified" {
                verified = true;
            }
            Ok(())
        }
    )
    .is_err());
    assert!(verified);
    assert_eq!(f.disk(), "original");
    f.clean();
    drop(reader);
    f.save("draft", "original").unwrap();
    assert_eq!(f.disk(), "draft");
    f.clean();
}

#[test]
fn replaced_staging_is_neither_written_nor_cleaned_as_our_own() {
    let f = Fixture::new();
    let mut replacement = None;
    assert!(save_sync(
        None,
        &display_path(&f.file),
        "draft",
        "original",
        |phase, record| {
            if phase == "copied" {
                let path = record.directory.join("content");
                std::fs::rename(&path, record.directory.join("our-original-stage"))?;
                std::fs::write(&path, "independent file")?;
                replacement = Some(path);
            }
            Ok(())
        }
    )
    .is_err());
    assert_eq!(f.disk(), "original");
    assert_eq!(
        std::fs::read_to_string(replacement.unwrap()).unwrap(),
        "independent file"
    );
}

#[cfg(windows)]
#[test]
fn windows_saves_handle_unicode_long_paths_and_existing_readers() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::*;
    let f = Fixture::new();
    let parent = f
        .root
        .join("long-directory-".repeat(12))
        .join("nested-".repeat(18));
    std::fs::create_dir_all(&parent).unwrap();
    let path = parent.join("文档.json");
    std::fs::write(&path, "original").unwrap();
    let old = File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(&path)
        .unwrap();
    save_sync(
        None,
        &display_path(&path),
        "新内容",
        "original",
        |_, _| Ok(()),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "新内容");
    assert_eq!(
        native::read_bounded(&mut old.try_clone().unwrap(), MAX_TEXT).unwrap(),
        b"original"
    );
}
