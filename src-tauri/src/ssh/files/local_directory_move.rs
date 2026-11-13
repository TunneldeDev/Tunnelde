//! Copy-based Windows directory moves. The immutable source inventory and each
//! verified file have separate journal rows, so checkpoints never rewrite the
//! whole tree. All proofs are synced before the first source can be removed.
//! Recovery never copies again after that boundary, or recursively deletes.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::ERROR_DIR_NOT_EMPTY;

use crate::error::{AppError, AppResult};
use crate::platform::file_identity::FileIdentity;
use crate::platform::guarded_file::{GuardedDirectory, GuardedFile};
use crate::state::AppState;

use super::durable::{Journal, MoveRecovery};
use super::{copy_entry, local_move, phase, progress, Endpoint, Meter, Outcome, CANCELLED};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    path: Vec<String>,
    source: FileIdentity,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: Vec<String>,
    source: FileIdentity,
    length: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    source: PathBuf,
    destination: PathBuf,
    directories: Vec<Directory>,
    files: Vec<Entry>,
}

fn unverified() -> AppError {
    AppError::validation("sftp.moveRecoveryUnverified")
}

fn check_cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    Ok(())
}

/// Resolve from the volume root while keeping each already resolved ancestor
/// pinned. OPEN_REPARSE_POINT only protects the final component of an open.
struct PinnedPath(Vec<(PathBuf, GuardedDirectory)>);

impl PinnedPath {
    fn open(path: &Path) -> AppResult<Self> {
        let absolute = std::path::absolute(path)?;
        let mut current = PathBuf::new();
        let mut guards = Vec::new();
        for component in absolute.components() {
            match component {
                Component::Prefix(_) => current.push(component),
                Component::RootDir | Component::Normal(_) => {
                    current.push(component);
                    guards.push((current.clone(), GuardedDirectory::pin(&current)?));
                }
                _ => return Err(unverified()),
            }
        }
        if guards.is_empty() {
            return Err(unverified());
        }
        Ok(Self(guards))
    }

    fn identity(&self) -> AppResult<FileIdentity> {
        Ok(self.0.last().ok_or_else(unverified)?.1.identity()?)
    }

    fn identity_at(&self, path: &Path) -> AppResult<FileIdentity> {
        let (_, guard) = self
            .0
            .iter()
            .find(|(current, _)| current == path)
            .ok_or_else(unverified)?;
        Ok(guard.identity()?)
    }

    fn check_source_streams(&self, path: &Path) -> AppResult<()> {
        let (_, guard) = self
            .0
            .iter()
            .find(|(current, _)| current == path)
            .ok_or_else(unverified)?;
        if guard.has_named_streams()? {
            return Err(AppError::validation("sftp.namedStreamsMoveUnavailable"));
        }
        Ok(())
    }
}

fn join(root: &Path, path: &[String]) -> PathBuf {
    path.iter()
        .fold(root.to_path_buf(), |parent, name| parent.join(name))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':', '\0'])
}

impl Manifest {
    fn capture(source: &Path, destination: &Path, cancel: &AtomicBool) -> AppResult<Self> {
        let source = std::path::absolute(source)?;
        let destination = std::path::absolute(destination)?;
        let mut directories = Vec::new();
        let mut files = Vec::new();
        let mut pending = vec![Vec::new()];
        while let Some(path) = pending.pop() {
            check_cancelled(cancel)?;
            let directory = join(&source, &path);
            let pinned = PinnedPath::open(&directory)?;
            pinned.check_source_streams(&directory)?;
            directories.push(Directory {
                path: path.clone(),
                source: pinned.identity()?,
            });
            for item in std::fs::read_dir(&directory)? {
                check_cancelled(cancel)?;
                let item = item?;
                let name = item.file_name().into_string().map_err(|_| unverified())?;
                if !valid_name(&name) {
                    return Err(unverified());
                }
                let mut child = path.clone();
                child.push(name);
                let metadata = std::fs::symlink_metadata(item.path())?;
                if metadata.is_dir() {
                    // Its own reparse flag and identity are checked when opened.
                    pending.push(child);
                } else {
                    let file = GuardedFile::read(&item.path())?;
                    if file.has_named_streams()? {
                        return Err(AppError::validation("sftp.namedStreamsMoveUnavailable"));
                    }
                    files.push(Entry {
                        path: child,
                        source: file.identity()?,
                        length: file.reader()?.metadata()?.len(),
                    });
                }
            }
        }
        directories.sort_by(|left, right| left.path.cmp(&right.path));
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = Self {
            version: 1,
            source,
            destination,
            directories,
            files,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> AppResult<()> {
        if self.version != 1 || !self.source.is_absolute() || !self.destination.is_absolute() {
            return Err(unverified());
        }
        if self
            .directories
            .windows(2)
            .any(|pair| pair[0].path >= pair[1].path)
        {
            return Err(unverified());
        }
        let mut directories = HashSet::new();
        let mut entries = HashSet::new();
        for directory in &self.directories {
            if !directory.path.iter().all(|name| valid_name(name))
                || !entries.insert(directory.path.clone())
                || (!directory.path.is_empty()
                    && !directories.contains(&directory.path[..directory.path.len() - 1]))
            {
                return Err(unverified());
            }
            directories.insert(directory.path.clone());
        }
        if !directories.contains(&Vec::<String>::new()) {
            return Err(unverified());
        }
        for file in &self.files {
            if file.path.is_empty()
                || !file.path.iter().all(|name| valid_name(name))
                || !entries.insert(file.path.clone())
                || !directories.contains(&file.path[..file.path.len() - 1])
            {
                return Err(unverified());
            }
        }
        Ok(())
    }

    fn total(&self) -> AppResult<u64> {
        self.files.iter().try_fold(0u64, |total, file| {
            total.checked_add(file.length).ok_or_else(unverified)
        })
    }

    fn directory(&self, path: &[String]) -> AppResult<&Directory> {
        self.directories
            .binary_search_by(|directory| directory.path.as_slice().cmp(path))
            .map(|index| &self.directories[index])
            .map_err(|_| unverified())
    }

    /// Check every recorded parent, not only the leaf. The complete absolute
    /// chain remains held by the returned guard while a caller operates below it.
    fn source_parent(
        &self,
        path: &[String],
        missing_allowed: bool,
    ) -> AppResult<Option<PinnedPath>> {
        let full = join(&self.source, path);
        let pinned = match PinnedPath::open(&full) {
            Ok(pinned) => pinned,
            Err(AppError::Io(error))
                if missing_allowed && error.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        for depth in 0..=path.len() {
            let directory = self.directory(&path[..depth])?;
            if pinned.identity_at(&join(&self.source, &directory.path))? != directory.source {
                return Err(unverified());
            }
            pinned.check_source_streams(&join(&self.source, &directory.path))?;
        }
        Ok(Some(pinned))
    }

    fn destination_parent(&self, path: &[String], store: &impl Store) -> AppResult<PinnedPath> {
        let pinned = PinnedPath::open(&join(&self.destination, path))?;
        for depth in 0..=path.len() {
            let directory = self.directory(&path[..depth])?;
            let expected: FileIdentity =
                load(store, &directory_key(&directory.path))?.ok_or_else(unverified)?;
            if pinned.identity_at(&join(&self.destination, &directory.path))? != expected {
                return Err(unverified());
            }
        }
        Ok(pinned)
    }

    fn prepare(&self, store: &impl Store, cancel: &AtomicBool) -> AppResult<()> {
        for directory in &self.directories {
            check_cancelled(cancel)?;
            let _source = self.source_parent(&directory.path, false)?;
            let target = join(&self.destination, &directory.path);
            let _parent = if directory.path.is_empty() {
                PinnedPath::open(target.parent().ok_or_else(unverified)?)?
            } else {
                self.destination_parent(&directory.path[..directory.path.len() - 1], store)?
            };
            let expected: Option<FileIdentity> = load(store, &directory_key(&directory.path))?;
            if expected.is_none() {
                match std::fs::create_dir(&target) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let target = PinnedPath::open(&target)?;
            let actual = target.identity()?;
            if expected
                .as_ref()
                .is_some_and(|expected| *expected != actual)
            {
                return Err(unverified());
            }
            if expected.is_none() {
                save(store, &directory_key(&directory.path), &actual)?;
            }
        }
        Ok(())
    }

    async fn remove_sources(&self, store: &impl Store, cancel: &AtomicBool) -> AppResult<()> {
        // Reject replaced directories before removing any remaining source file.
        for directory in &self.directories {
            check_cancelled(cancel)?;
            let _source = self.source_parent(&directory.path, true)?;
            let _destination = self.destination_parent(&directory.path, store)?;
        }
        for file in &self.files {
            let proof: MoveRecovery = load(store, &file_key(&file.path))?.ok_or_else(unverified)?;
            if proof.source != file.source || proof.length != file.length {
                return Err(unverified());
            }
        }
        for file in &self.files {
            check_cancelled(cancel)?;
            let parent = &file.path[..file.path.len() - 1];
            let _source = self.source_parent(parent, true)?;
            let _destination = self.destination_parent(parent, store)?;
            let proof: MoveRecovery = load(store, &file_key(&file.path))?.ok_or_else(unverified)?;
            if proof.source != file.source || proof.length != file.length {
                return Err(unverified());
            }
            local_move::recover(
                &join(&self.source, &file.path),
                &join(&self.destination, &file.path),
                &proof,
                cancel,
            )
            .await?;
        }
        for directory in self.directories.iter().rev() {
            check_cancelled(cancel)?;
            let target = join(&self.source, &directory.path);
            let _destination = self.destination_parent(&directory.path, store)?;
            let _parent = if directory.path.is_empty() {
                Some(PinnedPath::open(target.parent().ok_or_else(unverified)?)?)
            } else {
                self.source_parent(&directory.path[..directory.path.len() - 1], true)?
            };
            let guard = match GuardedDirectory::deletable(&target) {
                Ok(guard) => guard,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if guard.identity()? != directory.source {
                return Err(unverified());
            }
            if guard.has_named_streams()? {
                return Err(AppError::validation("sftp.namedStreamsMoveUnavailable"));
            }
            // Mark only this held directory for deletion. New files, including
            // files inserted after enumeration, cause an atomic refusal.
            guard.delete().map_err(|error| {
                if error.raw_os_error() == Some(ERROR_DIR_NOT_EMPTY as i32) {
                    AppError::validation("sftp.directoryMoveSourceChanged")
                } else {
                    error.into()
                }
            })?;
        }
        Ok(())
    }
}

trait Store {
    fn get(&self, key: &str) -> AppResult<Option<String>>;
    fn put(&self, key: &str, value: String) -> AppResult<()>;
}

fn load<T: serde::de::DeserializeOwned>(store: &impl Store, key: &str) -> AppResult<Option<T>> {
    store
        .get(key)?
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

fn save(store: &impl Store, key: &str, value: &impl Serialize) -> AppResult<()> {
    store.put(key, serde_json::to_string(value)?)
}

fn entry_key(kind: &str, path: &[String]) -> String {
    // JSON components have an unambiguous encoding even for unusual filenames.
    format!(
        "{kind}:{:x}",
        Sha256::digest(serde_json::to_vec(path).expect("string serialization"))
    )
}

fn directory_key(path: &[String]) -> String {
    entry_key("directory", path)
}
fn file_key(path: &[String]) -> String {
    entry_key("file", path)
}

struct AppStore<'a> {
    app: &'a AppHandle,
    id: &'a str,
}

impl Store for AppStore<'_> {
    fn get(&self, key: &str) -> AppResult<Option<String>> {
        self.app.state::<AppState>().db.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [format!("transfer-directory-move:{}:{key}", self.id)],
                    |r| r.get(0),
                )
                .optional()?)
        })
    }

    fn put(&self, key: &str, value: String) -> AppResult<()> {
        self.app.state::<AppState>().db.with(|conn| {
            conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![format!("transfer-directory-move:{}:{key}", self.id), value, crate::models::now_ms()])?;
            Ok(())
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    app: &AppHandle,
    from: &Endpoint,
    to: &Endpoint,
    id: &str,
    name: &str,
    cancel: &Arc<AtomicBool>,
    overwrite: bool,
    resuming: bool,
) -> Outcome {
    let store = AppStore { app, id };
    let observation = match app.state::<AppState>().transfers.observation(id) {
        Ok(observation) => observation,
        Err(error) => return Outcome::Failed(0, error),
    };
    let mut meter = Meter::new(app, id, name, 0, observation);
    let result = async {
        check_cancelled(cancel)?;
        let mut row = Journal::get(app, id)?;
        let raw = match store.get("manifest")? {
            Some(raw) => raw,
            None if row.directory_move_manifest.is_none() && !row.deleting_source => {
                super::check_local_destination(
                    Path::new(&from.path),
                    Path::new(&to.path),
                    overwrite,
                )?;
                let source = PathBuf::from(&from.path);
                let destination = PathBuf::from(&to.path);
                let cancelled = cancel.clone();
                let manifest = tokio::task::spawn_blocking(move || {
                    Manifest::capture(&source, &destination, &cancelled)
                })
                .await
                .map_err(|error| AppError::internal(error.to_string()))??;
                let raw = serde_json::to_string(&manifest)?;
                store.put("manifest", raw.clone())?;
                raw
            }
            None => return Err(unverified()),
        };
        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
        if row
            .directory_move_manifest
            .as_ref()
            .is_some_and(|expected| *expected != digest)
        {
            return Err(unverified());
        }
        let manifest: Manifest = serde_json::from_str(&raw)?;
        manifest.validate()?;
        if manifest.source != std::path::absolute(&from.path)?
            || manifest.destination != std::path::absolute(&to.path)?
        {
            return Err(unverified());
        }
        meter.total = manifest.total()?;
        progress(app, id, name, 0, meter.total);
        row.total = meter.total;
        row.directory_move_manifest = Some(digest);
        if row.deleting_source {
            phase(app, id, "verifying");
            meter.transferred = row.transferred;
            return manifest.remove_sources(&store, cancel).await;
        }
        Journal::upsert(app, row)?;
        manifest.prepare(&store, cancel)?;
        for file in &manifest.files {
            check_cancelled(cancel)?;
            let parent = &file.path[..file.path.len() - 1];
            let _source_parents = manifest.source_parent(parent, false)?;
            let _destination_parents = manifest.destination_parent(parent, &store)?;
            let source_path = join(&manifest.source, &file.path);
            let destination_path = join(&manifest.destination, &file.path);
            let source = local_move::Source::open(&source_path)?;
            if source.identity()? != file.source || source.length()? != file.length {
                return Err(unverified());
            }
            let previous: Option<MoveRecovery> = load(&store, &file_key(&file.path))?;
            if previous.is_none() {
                copy_entry(
                    &Endpoint {
                        session: None,
                        path: source_path.to_string_lossy().into_owned(),
                    },
                    &Endpoint {
                        session: None,
                        path: destination_path.to_string_lossy().into_owned(),
                    },
                    None,
                    None,
                    &mut meter,
                    cancel,
                    overwrite,
                    Some(id),
                    resuming,
                )
                .await?;
            } else {
                meter.add(file.length);
            }
            phase(app, id, "verifying");
            let verified = source.verify(&destination_path, cancel).await?;
            if previous
                .as_ref()
                .is_some_and(|proof| *proof != *verified.proof())
            {
                return Err(unverified());
            }
            if previous.is_none() {
                save(&store, &file_key(&file.path), verified.proof())?;
            }
        }
        check_cancelled(cancel)?;
        let mut row = Journal::get(app, id)?;
        row.deleting_source = true;
        row.transferred = meter.transferred;
        row.total = meter.total;
        // This FULL WAL commit syncs all preceding manifest, directory identity
        // and file-proof writes as well as the deletion-phase marker.
        Journal::commit_move_intent(app, row)?;
        phase(app, id, "verifying");
        manifest.remove_sources(&store, cancel).await
    }
    .await;
    Outcome::from_result(result, meter.transferred, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<BTreeMap<String, String>>);

    impl Store for MemoryStore {
        fn get(&self, key: &str) -> AppResult<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }

        fn put(&self, key: &str, value: String) -> AppResult<()> {
            self.0.lock().unwrap().insert(key.into(), value);
            Ok(())
        }
    }

    struct Fixture {
        root: PathBuf,
        manifest: Manifest,
        store: MemoryStore,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("tunnelde-directory-move-{}", uuid::Uuid::new_v4()));
            let source = root.join("source");
            std::fs::create_dir_all(source.join("nested/empty")).unwrap();
            std::fs::write(source.join("first.txt"), b"original first file").unwrap();
            std::fs::write(
                source.join("nested/第二个.txt"),
                vec![23; super::super::CHUNK * 2 + 31],
            )
            .unwrap();
            std::fs::write(source.join("nested/zero"), b"").unwrap();
            let manifest =
                Manifest::capture(&source, &root.join("destination"), &AtomicBool::new(false))
                    .unwrap();
            let store = MemoryStore::default();
            manifest.prepare(&store, &AtomicBool::new(false)).unwrap();
            Self {
                root,
                manifest,
                store,
            }
        }

        async fn copy(&self) {
            for file in &self.manifest.files {
                let source = join(&self.manifest.source, &file.path);
                let destination = join(&self.manifest.destination, &file.path);
                let guard = local_move::Source::open(&source).unwrap();
                assert_eq!(guard.identity().unwrap(), file.source);
                tokio::fs::copy(source, &destination).await.unwrap();
                let verified = guard
                    .verify(&destination, &AtomicBool::new(false))
                    .await
                    .unwrap();
                save(&self.store, &file_key(&file.path), verified.proof()).unwrap();
            }
        }

        async fn remove(&self) -> AppResult<()> {
            // Persisted state is serialized and reopened with no old handles.
            let manifest: Manifest =
                serde_json::from_slice(&serde_json::to_vec(&self.manifest).unwrap()).unwrap();
            manifest.validate()?;
            manifest
                .remove_sources(&self.store, &AtomicBool::new(false))
                .await
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[tokio::test]
    async fn copies_nested_unicode_empty_entries_and_recovers_after_completion() {
        let fixture = Fixture::new();
        fixture.copy().await;
        let expected: Vec<_> = fixture
            .manifest
            .files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    std::fs::read(join(&fixture.manifest.source, &file.path)).unwrap(),
                )
            })
            .collect();
        fixture.remove().await.unwrap();
        assert!(!fixture.manifest.source.exists());
        assert!(fixture.manifest.destination.join("nested/empty").is_dir());
        for (path, content) in expected {
            assert_eq!(
                std::fs::read(join(&fixture.manifest.destination, &path)).unwrap(),
                content
            );
        }
        // Interruption after removing root but before recording task completion.
        fixture.remove().await.unwrap();
    }

    #[tokio::test]
    async fn resumes_after_partial_file_and_directory_removal_without_copying_again() {
        let fixture = Fixture::new();
        fixture.copy().await;
        let first = &fixture.manifest.files[0];
        let proof = load(&fixture.store, &file_key(&first.path))
            .unwrap()
            .unwrap();
        local_move::recover(
            &join(&fixture.manifest.source, &first.path),
            &join(&fixture.manifest.destination, &first.path),
            &proof,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        std::fs::remove_dir(fixture.manifest.source.join("nested/empty")).unwrap();
        fixture.remove().await.unwrap();
        assert!(!fixture.manifest.source.exists());
        assert_eq!(
            std::fs::read(fixture.manifest.destination.join("first.txt")).unwrap(),
            b"original first file"
        );
    }

    #[tokio::test]
    async fn refuses_missing_proofs_before_removing_any_source() {
        let fixture = Fixture::new();
        fixture.copy().await;
        let last = fixture.manifest.files.last().unwrap();
        fixture
            .store
            .0
            .lock()
            .unwrap()
            .remove(&file_key(&last.path));
        assert_eq!(
            fixture.remove().await.unwrap_err().to_string(),
            "sftp.moveRecoveryUnverified"
        );
        for file in &fixture.manifest.files {
            assert!(join(&fixture.manifest.source, &file.path).exists());
        }
    }

    #[tokio::test]
    async fn preserves_replaced_or_modified_files_and_original_destination() {
        for source in [true, false] {
            for replace in [true, false] {
                let fixture = Fixture::new();
                fixture.copy().await;
                let file = &fixture.manifest.files[0];
                let base = if source {
                    &fixture.manifest.source
                } else {
                    &fixture.manifest.destination
                };
                let target = join(base, &file.path);
                let original = std::fs::read(&target).unwrap();
                if replace {
                    std::fs::rename(&target, fixture.root.join("retained-original")).unwrap();
                    std::fs::write(&target, &original).unwrap();
                } else {
                    let changed = vec![99; original.len()];
                    std::fs::write(&target, &changed).unwrap();
                }
                assert_eq!(
                    fixture.remove().await.unwrap_err().to_string(),
                    "sftp.moveRecoveryUnverified"
                );
                assert!(join(&fixture.manifest.source, &file.path).exists());
                assert!(join(&fixture.manifest.destination, &file.path).exists());
                if replace {
                    assert_eq!(
                        std::fs::read(fixture.root.join("retained-original")).unwrap(),
                        original
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn source_or_destination_directory_replacement_preserves_all_remaining_sources() {
        for source in [true, false] {
            let fixture = Fixture::new();
            fixture.copy().await;
            let directory = if source {
                &fixture.manifest.source
            } else {
                &fixture.manifest.destination
            }
            .join("nested");
            std::fs::rename(&directory, fixture.root.join("retained-directory")).unwrap();
            std::fs::create_dir(&directory).unwrap();
            assert_eq!(
                fixture.remove().await.unwrap_err().to_string(),
                "sftp.moveRecoveryUnverified"
            );
            assert!(fixture.manifest.source.join("first.txt").is_file());
            assert!(fixture.root.join("retained-directory/第二个.txt").is_file());
        }
    }

    #[tokio::test]
    async fn new_source_children_are_never_recursively_removed() {
        for directory in [false, true] {
            let fixture = Fixture::new();
            fixture.copy().await;
            let unexpected = fixture.manifest.source.join("new-child");
            let unexpected_file = if directory {
                std::fs::create_dir(&unexpected).unwrap();
                unexpected.join("new-file")
            } else {
                unexpected
            };
            std::fs::write(&unexpected_file, b"new unrelated data").unwrap();
            assert_eq!(
                fixture.remove().await.unwrap_err().to_string(),
                "sftp.directoryMoveSourceChanged"
            );
            assert_eq!(
                std::fs::read(&unexpected_file).unwrap(),
                b"new unrelated data"
            );
            assert_eq!(
                std::fs::read(fixture.manifest.destination.join("first.txt")).unwrap(),
                b"original first file"
            );
        }
    }

    #[tokio::test]
    async fn directory_named_streams_reject_capture_and_preserve_every_source_after_copy() {
        let fixture = Fixture::new();
        fixture.copy().await;
        let stream = PathBuf::from(format!("{}:metadata", fixture.manifest.source.display()));
        std::fs::write(&stream, b"directory source data").unwrap();
        assert_eq!(
            Manifest::capture(
                &fixture.manifest.source,
                &fixture.manifest.destination,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .to_string(),
            "sftp.namedStreamsMoveUnavailable"
        );
        assert_eq!(
            fixture.remove().await.unwrap_err().to_string(),
            "sftp.namedStreamsMoveUnavailable"
        );
        for file in &fixture.manifest.files {
            assert!(join(&fixture.manifest.source, &file.path).exists());
        }
        assert_eq!(std::fs::read(&stream).unwrap(), b"directory source data");
    }

    #[tokio::test]
    async fn cancellation_and_busy_writer_release_handles_and_allow_recovery() {
        let fixture = Fixture::new();
        fixture.copy().await;
        assert_eq!(
            fixture
                .manifest
                .remove_sources(&fixture.store, &AtomicBool::new(true))
                .await
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        let first = join(&fixture.manifest.source, &fixture.manifest.files[0].path);
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&first)
            .unwrap();
        assert!(fixture.remove().await.is_err());
        assert!(first.exists());
        drop(writer);
        fixture.remove().await.unwrap();
    }

    #[tokio::test]
    async fn deleted_source_with_missing_or_changed_copy_is_never_acknowledged() {
        for missing in [true, false] {
            let fixture = Fixture::new();
            fixture.copy().await;
            let file = &fixture.manifest.files[0];
            std::fs::remove_file(join(&fixture.manifest.source, &file.path)).unwrap();
            let destination = join(&fixture.manifest.destination, &file.path);
            if missing {
                std::fs::remove_file(&destination).unwrap();
            } else {
                std::fs::write(&destination, b"new destination").unwrap();
            }
            assert!(fixture.remove().await.is_err());
            assert!(fixture.manifest.source.exists());
            for remaining in &fixture.manifest.files[1..] {
                assert!(join(&fixture.manifest.source, &remaining.path).exists());
            }
        }
    }

    #[test]
    fn malformed_inventory_cannot_escape_its_roots_or_alias_entries() {
        let mut fixture = Fixture::new();
        for name in [
            "..",
            "a/b",
            "a\\b",
            "stream:other",
            "trailing.",
            "trailing ",
            "",
        ] {
            let previous = fixture.manifest.files[0].path.clone();
            fixture.manifest.files[0].path = vec![name.into()];
            assert!(fixture.manifest.validate().is_err(), "{name}");
            fixture.manifest.files[0].path = previous;
        }
        fixture.manifest.files[0].path = fixture.manifest.files[1].path.clone();
        assert!(fixture.manifest.validate().is_err());
    }

    #[test]
    fn pinned_ancestors_prevent_replacement_and_empty_only_deletion_rejects_new_children() {
        let fixture = Fixture::new();
        let path = fixture.manifest.source.join("nested/empty");
        let pinned = PinnedPath::open(&path).unwrap();
        assert!(
            std::fs::rename(&fixture.manifest.source, fixture.root.join("replacement")).is_err()
        );
        assert!(std::fs::rename(
            fixture.manifest.source.join("nested"),
            fixture.root.join("replacement")
        )
        .is_err());
        assert!(std::fs::rename(&path, fixture.root.join("replacement")).is_err());
        // Directory pinning intentionally does not promise frozen children.
        std::fs::write(path.join("new"), b"preserved").unwrap();
        drop(pinned);
        let guard = GuardedDirectory::deletable(&path).unwrap();
        assert_eq!(
            guard.delete().unwrap_err().raw_os_error(),
            Some(ERROR_DIR_NOT_EMPTY as i32)
        );
        assert_eq!(std::fs::read(path.join("new")).unwrap(), b"preserved");
    }
}
