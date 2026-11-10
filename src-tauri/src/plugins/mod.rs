pub mod api;
pub mod config;
pub mod configuration;
mod contributions;
mod declarative;
mod engines;
mod events;
mod extensions;
pub mod file_icons;
pub mod forwarding;
pub mod frontend;
mod host;
pub mod host_columns;
pub mod host_fields;
pub mod host_list;
pub mod host_sources;
mod logging;
pub mod manifest;
pub mod marketplace;
pub mod network;
pub mod node;
pub mod runners;
mod runtime;
pub mod security;
mod sessions;
pub mod status_bar;
pub mod tab_bar;
pub mod tasks;
mod tools;
pub mod wasm;

pub use runtime::activation::{ActivationPlan, PackageReview, PluginDependency, StartPermit};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::plugins::host::PluginHost;
use crate::plugins::manifest::{PluginCommand, PluginManifest, PluginTheme, PluginView};
use crate::plugins::wasm::WasmPlugin;

pub const STATE_EVENT: &str = "plugin://state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    Stopped,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// Immutable installed metadata for internal planning. Never crosses IPC.
    #[serde(skip)]
    pub(in crate::plugins) package_manifest: Arc<PluginManifest>,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub dependencies: Vec<PluginDependency>,
    pub host_fields: Option<crate::services::host_fields::Schema>,
    pub configuration:
        Option<crate::services::plugin_configuration::contracts::schema::Declaration>,
    pub description: Option<String>,
    pub commands: Vec<PluginCommand>,
    pub views: Vec<PluginView>,
    pub permissions: Vec<String>,
    pub status: PluginStatus,
    pub error: Option<String>,
    pub path: String,
    pub runtime: String,
    pub author: Option<String>,
    pub readme: Option<String>,
    pub engines: std::collections::BTreeMap<String, String>,
    pub source_id: Option<String>,
    pub source_url: Option<String>,
    pub themes: Vec<PluginTheme>,
    pub tags: Vec<String>,
    pub file_icon_themes: Vec<file_icons::FileIconTheme>,
    pub file_previews: Vec<crate::preview::providers::Provider>,
    pub mounted_file_reveal: bool,
    pub fingerprint: String,
    pub runtime_id: Option<String>,
    pub frontend: Option<frontend::FrontendManifest>,
}

struct Instance {
    manifest: PluginManifest,
    dir: PathBuf,
    status: PluginStatus,
    error: Option<String>,
    host: Option<PluginHost>,
    wasm: Option<WasmPlugin>,
    retired: bool,
    readme: Option<String>,
    node_source: Option<String>,
    fingerprint: String,
    runtime_lease: Option<security::Lease>,
    runtime_id: Option<String>,
}

impl Instance {
    fn new(manifest: PluginManifest, dir: PathBuf) -> Self {
        let fingerprint = security::fingerprint(&dir).unwrap_or_default();
        let readme = manifest
            .readme
            .as_deref()
            .and_then(|name| manifest::read_readme(&dir, name));
        let mut instance = Self {
            manifest,
            dir,
            status: PluginStatus::Stopped,
            error: None,
            host: None,
            wasm: None,
            retired: false,
            readme,
            node_source: None,
            fingerprint,
            runtime_lease: None,
            runtime_id: None,
        };
        if instance.is_wasm() {
            match instance.load_wasm() {
                Ok(wasm) => instance.wasm = Some(wasm),
                Err(error) => {
                    instance.status = PluginStatus::Failed;
                    instance.error = Some(error.to_string());
                }
            }
        }
        instance
    }

    fn is_wasm(&self) -> bool {
        self.manifest.runtime.as_deref() == Some("wasm")
    }

    fn require_runtime(&self) -> AppResult<()> {
        self.manifest.require_runtime()
    }

    fn load_wasm(&self) -> AppResult<WasmPlugin> {
        let entry = manifest::entry_path(&self.dir, &self.manifest.main)?;
        let bytes = std::fs::read(entry)?;
        WasmPlugin::load(&bytes)
    }

    fn info(&self) -> PluginInfo {
        PluginInfo {
            package_manifest: Arc::new(self.manifest.clone()),
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone(),
            api_version: self.manifest.api_version,
            dependencies: self.manifest.dependencies.clone(),
            host_fields: self.manifest.host_fields.clone(),
            configuration: self.manifest.configuration.clone(),
            description: self.manifest.description.clone(),
            commands: self.manifest.commands.clone(),
            views: self.manifest.views.clone(),
            permissions: self.manifest.permissions.clone(),
            status: self.status,
            error: self.error.clone(),
            path: self.dir.to_string_lossy().into_owned(),
            runtime: self
                .manifest
                .runtime
                .clone()
                .unwrap_or_else(|| "node".into()),
            author: self.manifest.author.clone(),
            readme: self.readme.clone(),
            engines: self.manifest.engines.clone(),
            source_id: marketplace::origin(&self.dir).map(|o| o.id),
            source_url: marketplace::origin(&self.dir).map(|o| o.url),
            themes: self.manifest.themes.clone(),
            file_icon_themes: self.manifest.file_icon_themes.clone(),
            file_previews: self.manifest.file_previews.clone(),
            mounted_file_reveal: self.manifest.mounted_file_reveal,
            tags: self.manifest.tags.clone(),
            fingerprint: self.fingerprint.clone(),
            runtime_id: (self.status == PluginStatus::Running)
                .then(|| self.runtime_id.clone())
                .flatten(),
            frontend: self.manifest.frontend.clone(),
        }
    }
}

pub struct PluginsManager {
    runtime_app: std::sync::OnceLock<AppHandle>,
    starts: Arc<runtime::activation::execution::coordination::Coordinator>,
    dir: PathBuf,
    plugins: Mutex<HashMap<String, Arc<Mutex<Instance>>>>,
    mutations: RwLock<()>,
    snapshots: std::sync::RwLock<HashMap<String, PluginInfo>>,
    runtime_sources: std::sync::RwLock<HashMap<String, (String, security::Lease)>>,
    pub(super) security: Arc<security::PluginSecurity>,
    status_bar: contributions::Registry<status_bar::StatusBarItem>,
    tab_bar: contributions::Registry<tab_bar::TabBarItem>,
    host_list: contributions::Registry<host_list::DecorationSet>,
    host_columns: contributions::Registry<host_columns::Column>,
    host_sources: contributions::Registry<host_sources::Source>,
    sessions: Arc<runtime::ownership::Registry<String>>,
}

impl PluginsManager {
    pub(crate) fn forget_connection(&self, session_id: &str) {
        self.sessions.forget(|id| id == session_id);
    }

    pub fn initialize_security(&self, db: &crate::db::Database, locked: bool) -> AppResult<()> {
        self.security.initialize(db, locked)
    }

    pub fn mark_clean(&self, db: &crate::db::Database) -> AppResult<()> {
        self.security.mark_clean(db)
    }

    pub async fn security_state(&self) -> security::SecurityState {
        let plugins = self.list().await;
        let identities = tokio::task::spawn_blocking(move || {
            plugins
                .into_iter()
                .filter(|plugin| plugin.runtime != "theme")
                .filter_map(|plugin| {
                    security::fingerprint(Path::new(&plugin.path))
                        .ok()
                        .map(|digest| (plugin.id, digest, plugin.permissions))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        self.security.snapshot(&identities)
    }

    pub async fn set_permissions(
        &self,
        db: &crate::db::Database,
        id: &str,
        permissions: Option<Vec<String>>,
        expected_fingerprint: Option<String>,
    ) -> AppResult<()> {
        if permissions.is_none() {
            // Revoke before waiting for an instance's in-flight command mutex.
            return self.security.set_permissions_with_cleanup(
                db,
                id,
                String::new(),
                &[],
                None,
                |retired| self.cleanup_policy_retirement(retired),
            );
        }
        let _mutation = self.mutations.write().await;
        let info = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::validation("plugin.notFound"))?;
        if info.runtime == "theme" {
            return Err(AppError::validation("plugin.theme.noRuntime"));
        }
        let digest = security::fingerprint_async(PathBuf::from(info.path)).await?;
        if permissions.is_some() && expected_fingerprint.as_deref() != Some(digest.as_str()) {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        self.security.set_permissions_with_cleanup(
            db,
            id,
            digest,
            &info.permissions,
            permissions,
            |retired| self.cleanup_policy_retirement(retired),
        )
    }

    pub fn force_cli_restricted(&self, app: &AppHandle, db: &crate::db::Database) {
        if let Err(error) = self.security.set_restricted(db, true, true) {
            tracing::error!(%error, "could not persist restricted extension mode");
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            app.state::<crate::state::AppState>()
                .plugins
                .stop_all_immediately(&app)
                .await;
            security::emit_state(&app).await;
        });
    }

    pub fn load(dir: PathBuf) -> Self {
        let mut plugins = HashMap::new();
        let mut snapshots = HashMap::new();
        // Recover an interrupted replacement before scanning ordinary plugin folders.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(id) = name
                    .strip_prefix(".backup-")
                    .filter(|id| manifest::valid_id(id))
                {
                    let target = dir.join(id);
                    if !entry.file_type().is_ok_and(|kind| kind.is_dir())
                        || !manifest::load(&entry.path()).is_ok_and(|value| value.id == id)
                    {
                        continue;
                    }
                    if !target.exists() {
                        let _ = std::fs::rename(entry.path(), &target);
                    } else if manifest::load(&target).is_ok_and(|value| value.id == id) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    } else {
                        // A crash may leave a partially written/corrupt target
                        // alongside the previous complete version. Quarantine
                        // it before restoring; never discard the good backup.
                        let failed = dir.join(format!(".failed-{}", uuid::Uuid::new_v4()));
                        if std::fs::rename(&target, &failed).is_ok() {
                            if std::fs::rename(entry.path(), &target).is_ok() {
                                let _ = std::fs::remove_dir_all(&failed);
                            } else {
                                let _ = std::fs::rename(&failed, &target);
                            }
                        }
                    }
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                match manifest::load(&path) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        if entry.file_name() != std::ffi::OsStr::new(&id) {
                            continue;
                        }
                        let instance = Instance::new(manifest, path);
                        snapshots.insert(id.clone(), instance.info());
                        plugins.insert(id, Arc::new(Mutex::new(instance)));
                    }
                    Err(error) => {
                        tracing::warn!(%error, dir = %path.display(), "skipping plugin");
                    }
                }
            }
        }
        Self {
            runtime_app: std::sync::OnceLock::new(),
            starts: runtime::activation::execution::coordination::Coordinator::new(),
            dir,
            plugins: Mutex::new(plugins),
            mutations: RwLock::new(()),
            snapshots: std::sync::RwLock::new(snapshots),
            runtime_sources: std::sync::RwLock::new(HashMap::new()),
            security: Arc::new(security::PluginSecurity::default()),
            status_bar: contributions::Registry::default(),
            tab_bar: contributions::Registry::default(),
            host_list: contributions::Registry::with_limit_error("plugin.hostList.limit"),
            host_columns: contributions::Registry::with_limit_error("plugin.hostList.limit"),
            host_sources: contributions::Registry::with_limit_error("plugin.hostSources.limit"),
            sessions: runtime::ownership::Registry::new(8, 64),
        }
    }

    pub(super) fn status_bar_name(&self, id: &str) -> String {
        self.snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map_or_else(|| id.to_owned(), |item| item.name.clone())
    }

    pub(super) fn with_host_fields<T>(
        &self,
        id: &str,
        fingerprint: Option<&str>,
        operation: impl FnOnce(&crate::services::host_fields::Schema) -> AppResult<T>,
    ) -> AppResult<T> {
        // Keep the installed schema stable through the bounded DB operation.
        // Package replacement/removal cannot interleave between validation and commit.
        let snapshots = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let plugin = snapshots
            .get(id)
            .ok_or_else(|| AppError::validation("plugin.notFound"))?;
        if fingerprint.is_some_and(|value| value != plugin.fingerprint) {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let schema = plugin
            .host_fields
            .as_ref()
            .ok_or_else(|| AppError::validation("hostFields.notDeclared"))?;
        operation(schema)
    }

    pub(super) fn status_bar_command(&self, id: &str, command: &str) -> bool {
        self.snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .is_some_and(|item| {
                item.commands.iter().any(|entry| {
                    entry.id == command
                        && entry.editor.is_none()
                        && entry.file_menu.is_none()
                        && !entry.host_menu
                })
            })
    }

    pub fn directory(&self) -> &Path {
        &self.dir
    }

    pub async fn list(&self) -> Vec<PluginInfo> {
        let mut list: Vec<_> = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect();
        list.sort_by_key(|plugin| plugin.name.to_lowercase());
        list
    }
    fn remember(&self, info: &PluginInfo) {
        self.snapshots
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .insert(info.id.clone(), info.clone());
    }
    fn forget(&self, id: &str) {
        self.snapshots
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
    }
    fn remember_source(&self, id: &str, source: Option<(String, security::Lease)>) {
        let mut sources = self
            .runtime_sources
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(source) = source {
            sources.insert(id.into(), source);
        } else {
            sources.remove(id);
        }
    }
    async fn instance(&self, id: &str) -> AppResult<Arc<Mutex<Instance>>> {
        self.plugins
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))
    }
}

/// Round-trips one request through a WASM plugin and parses its JSON answer.
fn wasm_call(
    instance: &Instance,
    request: Value,
    security: &Arc<security::PluginSecurity>,
    lease: &security::Lease,
) -> AppResult<Value> {
    if instance.status != PluginStatus::Running {
        return Err(AppError::validation("plugin.notRunning"));
    }
    let wasm = instance
        .wasm
        .as_ref()
        .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?;
    let payload = serde_json::to_string(&request)?;
    let response = wasm
        .call_with_security(&payload, Some((security.clone(), lease.clone())))
        .map_err(|error| AppError::validation(format!("plugin.wasm.call: {error}")))?;
    serde_json::from_str(&response)
        .map_err(|error| AppError::validation(format!("plugin.wasm.call: {error}")))
}
fn copy_dir(source: &Path, target: &Path) -> AppResult<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

const MAX_ARCHIVE_ENTRIES: usize = 2000;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// Validate a local package and show its identity before installation.
pub fn inspect(source: &str) -> AppResult<PluginManifest> {
    let source = Path::new(source);
    if source.is_dir() {
        return manifest::load(&locate_manifest_dir(source)?);
    }
    if !is_archive(source) {
        return Err(AppError::validation("plugin.manifest.unreadable"));
    }
    let temporary = std::env::temp_dir().join(format!("tunnelde-inspect-{}", uuid::Uuid::new_v4()));
    let result = extract_archive(source, &temporary)
        .and_then(|()| locate_manifest_dir(&temporary))
        .and_then(|directory| manifest::load(&directory));
    let _ = std::fs::remove_dir_all(&temporary);
    result
}

fn is_archive(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

/// Unpacks a plugin archive, refusing paths that escape the target folder and
/// capping the total size so a hostile archive cannot fill the disk.
fn extract_archive(archive: &Path, target: &Path) -> AppResult<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| AppError::validation(format!("plugin.archive: {error}")))?;
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::validation("plugin.archive.tooManyEntries"));
    }
    std::fs::create_dir_all(target)?;

    let mut written = 0_u64;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| AppError::validation(format!("plugin.archive: {error}")))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::validation("plugin.archive.path"))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::validation("plugin.archive.path"));
        }
        let destination = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination)?;
            continue;
        }
        written += entry.size();
        if written > MAX_ARCHIVE_BYTES {
            return Err(AppError::validation("plugin.archive.tooLarge"));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&destination)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// Accepts both a bare plugin folder and an archive with a single top folder.
fn locate_manifest_dir(root: &Path) -> AppResult<PathBuf> {
    if root.join(manifest::MANIFEST_FILE).is_file() {
        return Ok(root.to_path_buf());
    }
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path().join(manifest::MANIFEST_FILE).is_file() {
            candidates.push(entry.path());
        }
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        _ => Err(AppError::validation("plugin.manifest.missing")),
    }
}

fn activate_package(
    root: &Path,
    target: &Path,
    backup: &Path,
    update: bool,
    validate: impl FnOnce(&Path) -> AppResult<PluginManifest>,
) -> AppResult<PluginManifest> {
    if update {
        std::fs::rename(target, backup)?;
    }
    if let Err(error) = std::fs::rename(root, target) {
        if update {
            std::fs::rename(backup, target)?;
        }
        return Err(error.into());
    }
    match validate(target) {
        Ok(manifest) => Ok(manifest),
        Err(error) => {
            std::fs::rename(target, root)
                .map_err(|_| AppError::validation("market.recoveryNeeded"))?;
            if update {
                std::fs::rename(backup, target)
                    .map_err(|_| AppError::validation("market.recoveryNeeded"))?;
            }
            Err(error)
        }
    }
}

impl PluginsManager {
    pub async fn install_market(
        &self,
        root: &Path,
        source: &config::MarketSource,
        update: bool,
    ) -> AppResult<PluginInfo> {
        let _mutation = self.mutations.write().await;
        let manifest = manifest::load(root)?;
        let target = self.dir.join(&manifest.id);
        let backup = self.dir.join(format!(".backup-{}", manifest.id));
        let root = root.canonicalize()?;
        std::fs::create_dir_all(&self.dir)?;
        let directory = self.dir.canonicalize()?;
        // A package cannot contain the installation root, nor be the installed
        // target itself. These moves cannot be completed or safely rolled back.
        if directory.starts_with(&root) || root == directory.join(&manifest.id) {
            return Err(AppError::validation("plugin.entry.outside"));
        }
        if manifest.runtime.as_deref() == Some("wasm") {
            WasmPlugin::load(&std::fs::read(manifest::entry_path(
                &root,
                &manifest.main,
            )?)?)?;
        }
        let previous = self.plugins.lock().await.get(&manifest.id).cloned();
        let mut previous = match previous.as_ref() {
            Some(value) => Some(value.lock().await),
            None => None,
        };
        if update {
            let old = previous
                .as_ref()
                .ok_or_else(|| AppError::validation("plugin.notFound"))?;
            let origin = marketplace::origin(&old.dir)
                .ok_or_else(|| AppError::validation("market.sourceMismatch"))?;
            if origin.id != source.id || origin.url != source.url {
                return Err(AppError::validation("market.sourceMismatch"));
            }
            let old_version = manifest::normalized_version(&old.manifest.version)
                .ok_or_else(|| AppError::validation("plugin.version.invalid"))?;
            if manifest::normalized_version(&manifest.version)
                .is_none_or(|version| version <= old_version)
            {
                return Err(AppError::validation("market.notNewer"));
            }
        } else if previous.is_some() || target.exists() {
            return Err(AppError::validation("plugin.exists"));
        }
        std::fs::write(
            root.join(marketplace::ORIGIN_FILE),
            serde_json::to_vec(source)?,
        )?;
        if backup.exists() {
            return Err(AppError::validation("market.recoveryNeeded"));
        }
        if update {
            if let Some(old) = previous.as_mut() {
                old.terminate_host().await?;
                old.wasm = None;
                old.status = PluginStatus::Stopped;
                old.error = None;
                self.remember(&old.info());
            }
        }
        let copied = match activate_package(&root, &target, &backup, update, manifest::load) {
            Ok(value) => value,
            Err(error) => {
                if backup.exists() {
                    if let Some(old) = previous.as_mut() {
                        old.retired = true;
                    }
                    self.plugins.lock().await.remove(&manifest.id);
                    self.forget(&manifest.id);
                }
                return Err(error);
            }
        };
        let instance = Instance::new(copied, target);
        self.invalidate_plugin(&instance.manifest.id);
        self.remember_source(&instance.manifest.id, None);
        let info = instance.info();
        self.remember(&info);
        if let Some(old) = previous.as_mut() {
            old.retired = true;
        }
        self.plugins
            .lock()
            .await
            .insert(info.id.clone(), Arc::new(Mutex::new(instance)));
        if update {
            if let Err(error) = std::fs::remove_dir_all(&backup) {
                tracing::warn!(%error,"plugin backup cleanup failed");
            }
        }
        Ok(info)
    }

    pub async fn install(&self, source: &str) -> AppResult<PluginInfo> {
        let source = PathBuf::from(source);
        let archive = is_archive(&source);
        let extracted =
            archive.then(|| self.dir.join(format!(".install-{}", uuid::Uuid::new_v4())));
        let result = match &extracted {
            Some(directory) => {
                extract_archive(&source, directory).and_then(|()| locate_manifest_dir(directory))
            }
            None => Ok(source.clone()),
        };
        let root = match result {
            Ok(root) => root,
            Err(error) => {
                if let Some(directory) = &extracted {
                    let _ = std::fs::remove_dir_all(directory);
                }
                return Err(error);
            }
        };

        let outcome = self.install_from(&root).await;
        if let Some(directory) = extracted {
            let _ = std::fs::remove_dir_all(directory);
        }
        outcome
    }

    async fn install_from(&self, root: &Path) -> AppResult<PluginInfo> {
        let _mutation = self.mutations.write().await;
        let manifest = manifest::load(root)?;
        let target = self.dir.join(&manifest.id);
        if target.exists() {
            return Err(AppError::validation("plugin.exists"));
        }

        let stage = self.dir.join(format!(".install-{}", uuid::Uuid::new_v4()));
        if let Err(error) = copy_dir(root, &stage) {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error);
        }
        let _ = std::fs::remove_file(stage.join(marketplace::ORIGIN_FILE));
        let copied = match manifest::load(&stage) {
            Ok(copied) => copied,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&stage);
                return Err(error);
            }
        };

        if copied.runtime.as_deref() == Some("wasm") {
            let validation = manifest::entry_path(&stage, &copied.main)
                .and_then(|path| WasmPlugin::load(&std::fs::read(path)?));
            if let Err(error) = validation {
                let _ = std::fs::remove_dir_all(&stage);
                return Err(error);
            }
        }
        if let Err(error) = std::fs::rename(&stage, &target) {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error.into());
        }

        let instance = Instance::new(copied, target);
        self.invalidate_plugin(&instance.manifest.id);
        self.remember_source(&instance.manifest.id, None);
        let info = instance.info();
        self.remember(&info);
        self.plugins
            .lock()
            .await
            .insert(info.id.clone(), Arc::new(Mutex::new(instance)));
        Ok(info)
    }

    pub async fn uninstall(&self, id: &str) -> AppResult<()> {
        let _mutation = self.mutations.write().await;
        self.invalidate_plugin(id);
        self.remember_source(id, None);
        let handle = self.instance(id).await?;
        let mut instance = handle.lock().await;
        instance.terminate_host().await?;
        instance.node_source = None;
        instance.wasm = None;
        instance.status = PluginStatus::Stopped;
        instance.error = None;
        self.remember(&instance.info());
        std::fs::remove_dir_all(&instance.dir)?;
        instance.retired = true;
        self.plugins.lock().await.remove(id);
        self.forget(id);
        Ok(())
    }

    pub async fn reload(&self) -> Vec<PluginInfo> {
        self.starts.cancel_all();
        let _mutation = self.mutations.write().await;
        self.security.invalidate_runtimes();
        self.runtime_sources
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        if let Err(error) = self.quiesce_catalogue().await {
            tracing::error!(
                error_code = error.code(),
                "plugin reload retained engines with unconfirmed termination"
            );
            return self.list().await;
        }
        let fresh = Self::load(self.dir.clone());
        *self
            .snapshots
            .write()
            .unwrap_or_else(|error| error.into_inner()) = fresh
            .snapshots
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());
        *self.plugins.lock().await = fresh.plugins.into_inner();
        self.list().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(dir: &Path) {
        std::fs::create_dir_all(dir).expect("plugin dir");
        std::fs::write(dir.join("index.js"), "console.log('hello');\n").expect("entry");
        std::fs::write(dir.join(manifest::MANIFEST_FILE), MANIFEST).expect("manifest");
    }

    const MANIFEST: &str =
        r#"{"id":"demo","name":"Demo","version":"0.1.0","apiVersion":1,"main":"index.js"}"#;

    fn write_archive(path: &Path, folder: &str) {
        use std::io::Write;
        let file = std::fs::File::create(path).expect("archive file");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in [
            ("tunnelde-plugin.json", MANIFEST),
            ("index.js", "console.log('hello');\n"),
        ] {
            zip.start_file(format!("{folder}/{name}"), options)
                .expect("entry");
            zip.write_all(body.as_bytes()).expect("body");
        }
        zip.finish().expect("finish");
    }

    fn write_archive_entries(path: &Path, entries: &[(&str, &str)]) {
        use std::io::Write;
        let file = std::fs::File::create(path).expect("archive file");
        let mut archive = zip::ZipWriter::new(file);
        for (name, body) in entries {
            archive
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("archive entry");
            archive.write_all(body.as_bytes()).expect("archive body");
        }
        archive.finish().expect("finish archive");
    }

    #[test]
    fn inspects_bare_and_wrapped_plugin_folders_without_installing() {
        let root = temp_root("inspect-folders");
        let source = root.join("source");
        write_plugin(&source);

        for candidate in [&source, &root] {
            let inspected = inspect(candidate.to_str().unwrap()).expect("inspect folder");
            assert_eq!(inspected.id, "demo");
            assert_eq!(inspected.name, "Demo");
            assert_eq!(inspected.version, "0.1.0");
            assert_eq!(inspected.main, "index.js");
        }
        assert!(source.join("index.js").exists());
        assert_eq!(std::fs::read_dir(&root).expect("source parent").count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspects_root_and_wrapped_zip_packages() {
        let root = temp_root("inspect-archives");
        let flat = root.join("flat.ZIP");
        write_archive_entries(
            &flat,
            &[(manifest::MANIFEST_FILE, MANIFEST), ("index.js", "")],
        );
        let wrapped = root.join("wrapped.zip");
        write_archive(&wrapped, "demo-0.1.0");

        for archive in [&flat, &wrapped] {
            let original = std::fs::read(archive).expect("original package");
            let inspected = inspect(archive.to_str().unwrap()).expect("inspect archive");
            assert_eq!(inspected.id, "demo");
            assert_eq!(inspected.api_version, manifest::API_VERSION);
            assert_eq!(inspected.version, "0.1.0");
            assert_eq!(std::fs::read(archive).expect("unchanged package"), original);
        }
        assert_eq!(std::fs::read_dir(&root).expect("package parent").count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_rejects_unsupported_files_and_corrupt_archives() {
        let root = temp_root("inspect-unreadable");
        let unsupported = root.join("package.txt");
        std::fs::write(&unsupported, MANIFEST).expect("unsupported package");
        let corrupt = root.join("corrupt.zip");
        std::fs::write(&corrupt, "this is not an archive").expect("corrupt package");

        for (source, expected) in [
            (&unsupported, "plugin.manifest.unreadable"),
            (&corrupt, "plugin.archive"),
        ] {
            let error = inspect(source.to_str().unwrap()).expect_err("invalid package");
            assert!(error.to_string().contains(expected), "{error}");
        }
        assert!(inspect(root.join("missing.zip").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_validates_manifest_and_entry_in_folders_and_archives() {
        let root = temp_root("inspect-validation");
        let folder = root.join("source");
        write_plugin(&folder);
        let archive = root.join("invalid.zip");
        let invalid_api = MANIFEST.replace("\"apiVersion\":1", "\"apiVersion\":99");
        let cases = [
            ("not json", Some(""), "plugin.manifest.invalid"),
            (
                invalid_api.as_str(),
                Some(""),
                "plugin.apiVersion.unsupported",
            ),
            (MANIFEST, None, "plugin.entry.missing"),
        ];
        for (manifest_body, entry_body, expected) in cases {
            std::fs::write(folder.join(manifest::MANIFEST_FILE), manifest_body)
                .expect("invalid manifest");
            let mut entries = vec![(manifest::MANIFEST_FILE, manifest_body)];
            if let Some(entry) = entry_body {
                std::fs::write(folder.join("index.js"), entry).expect("entry");
                entries.push(("index.js", entry));
            } else {
                std::fs::remove_file(folder.join("index.js")).expect("remove entry");
            }
            write_archive_entries(&archive, &entries);
            for source in [&folder, &archive] {
                let error = inspect(source.to_str().unwrap()).expect_err("invalid package");
                assert!(error.to_string().contains(expected), "{error}");
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_rejects_empty_and_ambiguous_packages() {
        let root = temp_root("inspect-ambiguous");
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).expect("empty folder");
        let archive = root.join("ambiguous.zip");
        write_archive_entries(
            &archive,
            &[
                ("one/tunnelde-plugin.json", MANIFEST),
                ("one/index.js", ""),
                ("two/tunnelde-plugin.json", MANIFEST),
                ("two/index.js", ""),
            ],
        );
        for source in [&empty, &archive] {
            let error = inspect(source.to_str().unwrap()).expect_err("missing single plugin");
            assert!(
                error.to_string().contains("plugin.manifest.missing"),
                "{error}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn installs_from_an_archive() {
        let root = temp_root("archive");
        let archive = root.join("demo.zip");
        write_archive(&archive, "demo-0.1.0");
        let manager = PluginsManager::load(root.join("installed"));

        let installed = manager
            .install(archive.to_str().unwrap())
            .await
            .expect("install");
        assert_eq!(installed.id, "demo");
        assert!(root
            .join("installed")
            .join("demo")
            .join("index.js")
            .exists());
        // The temporary extraction folder must not survive.
        let leftovers: Vec<_> = std::fs::read_dir(root.join("installed"))
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".install-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn rejects_archives_without_a_single_plugin_folder() {
        let root = temp_root("locate");
        assert!(locate_manifest_dir(&root).is_err());
        std::fs::create_dir_all(root.join("one")).expect("one");
        std::fs::write(root.join("one").join(manifest::MANIFEST_FILE), MANIFEST).expect("manifest");
        assert_eq!(locate_manifest_dir(&root).unwrap(), root.join("one"));
        std::fs::create_dir_all(root.join("two")).expect("two");
        std::fs::write(root.join("two").join(manifest::MANIFEST_FILE), MANIFEST).expect("manifest");
        assert!(locate_manifest_dir(&root).is_err());
    }

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("tunnelde-plugins-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        root
    }

    #[tokio::test]
    async fn installs_and_uninstalls_a_plugin() {
        let root = temp_root("install");
        let source = root.join("source");
        write_plugin(&source);
        let manager = PluginsManager::load(root.join("installed"));

        let installed = manager
            .install(source.to_str().unwrap())
            .await
            .expect("install");
        assert_eq!(installed.id, "demo");
        assert!(root
            .join("installed")
            .join("demo")
            .join("index.js")
            .exists());
        assert_eq!(manager.list().await.len(), 1);

        assert!(manager.install(source.to_str().unwrap()).await.is_err());
        manager.uninstall("demo").await.expect("uninstall");
        assert!(!root.join("installed").join("demo").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn grant_requires_the_reviewed_package_snapshot_and_reinstall_clears_consent() {
        let root = temp_root("grant-snapshot");
        let source = root.join("source");
        write_plugin(&source);
        let manager = PluginsManager::load(root.join("installed"));
        let db = crate::db::Database::in_memory().unwrap();
        let installed = manager.install(source.to_str().unwrap()).await.unwrap();
        manager
            .set_permissions(
                &db,
                "demo",
                Some(installed.permissions.clone()),
                Some(installed.fingerprint.clone()),
            )
            .await
            .unwrap();
        assert!(manager.security_state().await.grants.contains_key("demo"));
        std::fs::write(root.join("installed/demo/index.js"), "changed code").unwrap();
        let error = manager
            .set_permissions(
                &db,
                "demo",
                Some(installed.permissions.clone()),
                Some(installed.fingerprint),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "pluginSecurity.changed");
        assert!(manager.security_state().await.grants.is_empty());
        manager.uninstall("demo").await.unwrap();
        let reinstalled = manager.install(source.to_str().unwrap()).await.unwrap();
        assert!(!reinstalled.fingerprint.is_empty());
        assert!(manager.security_state().await.grants.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reload_picks_up_plugins_added_on_disk() {
        let root = temp_root("reload");
        let manager = PluginsManager::load(root.clone());
        assert!(manager.list().await.is_empty());

        write_plugin(&root.join("demo"));
        let list = manager.reload().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Demo");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn market_update_requires_same_source_and_a_newer_version() {
        let root = temp_root("market-identity");
        let manager = PluginsManager::load(root.join("installed"));
        let first = root.join("first");
        write_plugin(&first);
        let source = config::official();
        let info = manager
            .install_market(&first, &source, false)
            .await
            .unwrap();
        assert_eq!(info.source_id.as_deref(), Some("official"));
        let next = root.join("next");
        write_plugin(&next);
        assert!(manager
            .install_market(&next, &source, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("market.notNewer"));
        std::fs::write(
            next.join(manifest::MANIFEST_FILE),
            MANIFEST.replace("0.1.0", "0.2.0"),
        )
        .unwrap();
        let wrong_source = config::MarketSource {
            id: "another".into(),
            url: "https://example.org/plugins.json".into(),
            ..source.clone()
        };
        assert!(manager
            .install_market(&next, &wrong_source, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("market.sourceMismatch"));
        assert_eq!(manager.list().await[0].version, "0.1.0");
        assert!(next.is_dir());
        let updated = manager.install_market(&next, &source, true).await.unwrap();
        assert_eq!(updated.version, "0.2.0");
        assert_eq!(manager.list().await[0].version, "0.2.0");
        assert!(!root.join("installed/.backup-demo").exists());
        assert!(!next.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn theme_pack_inspects_installs_updates_and_exposes_all_themes_without_node() {
        let probes = node::probe_count_for_test();
        let root = temp_root("theme-pack-lifecycle");
        let body = serde_json::json!({"id":"theme-pack", "name":"Theme Pack", "version":"1.0.0", "apiVersion":1,
            "runtime":"theme", "themes":[
                {"id":"night", "name":"Night", "appearance":"dark", "colors":{"background":"#101010"}},
                {"id":"day", "name":"Day", "appearance":"light", "accent":"#0088ff", "colors":{"sidebar":"#fafafa"}}]});
        let archive = root.join("theme.zip");
        write_archive_entries(&archive, &[(manifest::MANIFEST_FILE, &body.to_string())]);
        let preview = inspect(archive.to_str().unwrap()).unwrap();
        assert!(preview.main.is_empty());
        assert_eq!(preview.themes.len(), 2);
        let manager = PluginsManager::load(root.join("installed"));
        let info = manager.install(archive.to_str().unwrap()).await.unwrap();
        assert_eq!(info.runtime, "theme");
        assert_eq!(info.themes.len(), 2);
        assert_eq!(info.themes[1].accent.as_deref(), Some("#0088ff"));
        assert_eq!(manager.list().await[0].themes.len(), 2);
        assert!(manager
            .run("theme-pack", "run", None, "")
            .await
            .unwrap_err()
            .to_string()
            .contains("plugin.theme.noRuntime"));
        assert!(manager
            .render_view("theme-pack", "panel", None, "")
            .await
            .unwrap_err()
            .to_string()
            .contains("plugin.theme.noRuntime"));
        {
            let handle = manager.instance("theme-pack").await.unwrap();
            let instance = handle.lock().await;
            // This is the first guard used by start(), before AppState or Node
            // detection is accessed. A theme pack never has a live runtime.
            assert!(instance.require_runtime().is_err());
            assert!(instance.host.is_none());
            assert!(instance.wasm.is_none());
            assert!(instance.node_source.is_none());
        }
        let installed = root.join("installed/theme-pack");
        std::fs::write(
            installed.join(marketplace::ORIGIN_FILE),
            serde_json::to_vec(&config::official()).unwrap(),
        )
        .unwrap();
        let next = root.join("next");
        std::fs::create_dir(&next).unwrap();
        let mut changed = body;
        changed["version"] = "1.1.0".into();
        changed["themes"][0]["colors"]["background"] = "#121212".into();
        std::fs::write(
            next.join(manifest::MANIFEST_FILE),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        let updated = manager
            .install_market(&next, &config::official(), true)
            .await
            .unwrap();
        assert_eq!(updated.version, "1.1.0");
        assert_eq!(
            updated.themes[0]
                .colors
                .get("background")
                .map(String::as_str),
            Some("#121212")
        );
        assert_eq!(node::probe_count_for_test(), probes);
        manager.uninstall("theme-pack").await.unwrap();
        assert!(manager.list().await.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn file_icon_pack_round_trips_through_inspection_install_and_reload_without_node() {
        let probes = node::probe_count_for_test();
        let root = temp_root("file-icon-lifecycle");
        let body = serde_json::json!({"id":"file-icons", "name":"File Icons", "version":"1.0.0", "apiVersion":1,
            "runtime":"theme", "fileIconThemes":[{"id":"common", "name":"Common files",
                "icons":{"ts":{"symbol":"code", "label":"TS", "color":"#3178C6"}},
                "extensions":{"ts":"ts"}}]});
        let archive = root.join("icons.zip");
        write_archive_entries(&archive, &[(manifest::MANIFEST_FILE, &body.to_string())]);
        assert_eq!(
            inspect(archive.to_str().unwrap())
                .unwrap()
                .file_icon_themes
                .len(),
            1
        );
        let manager = PluginsManager::load(root.join("installed"));
        let installed = manager.install(archive.to_str().unwrap()).await.unwrap();
        assert_eq!(installed.file_icon_themes[0].extensions["ts"], "ts");
        let restored = PluginsManager::load(root.join("installed"));
        let list = restored.list().await;
        assert_eq!(
            list[0].file_icon_themes[0].icons["ts"].label.as_deref(),
            Some("TS")
        );
        assert!(list[0].permissions.is_empty());
        assert_eq!(list[0].runtime, "theme");
        assert!(restored.run("file-icons", "run", None, "").await.is_err());
        assert_eq!(node::probe_count_for_test(), probes);
        restored.uninstall("file-icons").await.unwrap();
        assert!(restored.list().await.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "opt-in: set TUNNELDE_TEST_ICON_PACKAGE to a built hub ZIP"]
    async fn live_hub_file_icon_archive_installs_without_a_runtime() {
        let archive = std::env::var("TUNNELDE_TEST_ICON_PACKAGE").expect("icon package ZIP");
        let root = temp_root("hub-icons");
        let manager = PluginsManager::load(root.join("installed"));
        let preview = inspect(&archive).unwrap();
        assert_eq!(preview.id, "file-icons");
        let info = manager.install(&archive).await.unwrap();
        assert_eq!(info.runtime, "theme");
        let theme = &info.file_icon_themes[0];
        for extension in [
            "mp3", "mp4", "pdf", "md", "png", "jpg", "gif", "tar.gz", "ts", "py", "rs",
        ] {
            assert!(theme.icons.contains_key(&theme.extensions[extension]));
        }
        assert!(info.permissions.is_empty());
        assert!(manager.run("file-icons", "run", None, "").await.is_err());
        manager.uninstall("file-icons").await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "opt-in: set TUNNELDE_TEST_PREVIEW_PACKAGE to a built hub ZIP"]
    async fn live_hub_preview_archive_installs_without_a_runtime() {
        let archive = std::env::var("TUNNELDE_TEST_PREVIEW_PACKAGE").expect("preview ZIP");
        let root = temp_root("hub-previews");
        let manager = PluginsManager::load(root.join("installed"));
        let info = manager.install(&archive).await.unwrap();
        assert_eq!(info.id, "file-previews");
        assert_eq!(info.runtime, "theme");
        assert!(info.permissions.is_empty());
        for extension in ["mp3", "mp4", "pdf", "md", "png", "jpg", "gif"] {
            assert!(info
                .file_previews
                .iter()
                .any(|provider| provider.matches(&format!("test.{extension}"))));
        }
        assert!(manager.run("file-previews", "run", None, "").await.is_err());
        let restored = PluginsManager::load(root.join("installed"));
        assert_eq!(restored.list().await[0].file_previews.len(), 6);
        restored.uninstall("file-previews").await.unwrap();
        assert!(restored.list().await.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_activation_restores_original_package_and_preserves_staging() {
        let root = temp_root("activation-rollback");
        let target = root.join("demo");
        write_plugin(&target);
        let staged = root.join("stage");
        write_plugin(&staged);
        std::fs::write(
            staged.join(manifest::MANIFEST_FILE),
            MANIFEST.replace("0.1.0", "0.2.0"),
        )
        .unwrap();
        let backup = root.join(".backup-demo");
        let result = activate_package(&staged, &target, &backup, true, |_| {
            Err(AppError::validation("injected.validationFailure"))
        });
        assert!(result.is_err());
        assert_eq!(manifest::load(&target).unwrap().version, "0.1.0");
        assert_eq!(manifest::load(&staged).unwrap().version, "0.2.0");
        assert!(!backup.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn startup_recovers_missing_or_corrupt_target_and_cleans_committed_backup() {
        for state in ["missing", "corrupt", "committed"] {
            let root = temp_root(&format!("recovery-{state}"));
            let backup = root.join(".backup-demo");
            write_plugin(&backup);
            let target = root.join("demo");
            if state != "missing" {
                write_plugin(&target);
                std::fs::write(
                    target.join(manifest::MANIFEST_FILE),
                    if state == "corrupt" {
                        "broken".into()
                    } else {
                        MANIFEST.replace("0.1.0", "0.2.0")
                    },
                )
                .unwrap();
            }
            let manager = PluginsManager::load(root.clone());
            let plugins = manager.list().await;
            assert_eq!(plugins.len(), 1, "{state}");
            assert_eq!(
                plugins[0].version,
                if state == "committed" {
                    "0.2.0"
                } else {
                    "0.1.0"
                }
            );
            assert!(!backup.exists(), "{state}");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_wasm_cannot_replace_a_working_package_or_leave_partial_local_install() {
        let root = temp_root("invalid-wasm-install");
        let manager = PluginsManager::load(root.join("installed"));
        let first = root.join("first");
        write_plugin(&first);
        manager
            .install_market(&first, &config::official(), false)
            .await
            .unwrap();
        let invalid = root.join("invalid");
        write_wasm_plugin(&invalid, "demo", b"broken wasm");
        let metadata = std::fs::read_to_string(invalid.join(manifest::MANIFEST_FILE))
            .unwrap()
            .replace("0.1.0", "0.2.0");
        std::fs::write(invalid.join(manifest::MANIFEST_FILE), metadata).unwrap();
        assert!(manager
            .install_market(&invalid, &config::official(), true)
            .await
            .is_err());
        assert_eq!(manager.list().await[0].version, "0.1.0");
        let separate = PluginsManager::load(root.join("local"));
        assert!(separate.install(invalid.to_str().unwrap()).await.is_err());
        assert!(separate.list().await.is_empty());
        assert_eq!(std::fs::read_dir(root.join("local")).unwrap().count(), 0);
        assert!(invalid.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn one_busy_plugin_does_not_block_another_plugin_command() {
        let root = temp_root("independent-locks");
        write_wasm_plugin(&root.join("one"), "one", WASM_STUB.as_bytes());
        write_wasm_plugin(&root.join("two"), "two", WASM_STUB.as_bytes());
        let manager = PluginsManager::load(root.clone());
        let db = crate::db::Database::in_memory().unwrap();
        let two = manager
            .list()
            .await
            .into_iter()
            .find(|plugin| plugin.id == "two")
            .unwrap();
        manager
            .set_permissions(&db, "two", Some(vec![]), Some(two.fingerprint))
            .await
            .unwrap();
        let runtime_id = {
            let handle = manager.instance("two").await.unwrap();
            let mut instance = handle.lock().await;
            let lease = manager
                .security
                .lease("two", instance.fingerprint.clone(), vec![])
                .unwrap();
            let activation = manager.security.begin_runtime(&lease, &[], false).unwrap();
            manager.security.native_ready(&lease).unwrap();
            activation.commit();
            instance.runtime_id = Some(manager.security.lease_stamp(&lease));
            instance.runtime_lease = Some(lease);
            instance.status = PluginStatus::Running;
            let info = instance.info();
            manager.remember(&info);
            info.runtime_id.unwrap()
        };
        let first = manager.instance("one").await.unwrap();
        let _busy = first.lock().await;
        // The stub returns invalid JSON; reaching that response still proves
        // the second command acquired its own lock without waiting on "one".
        let result = tokio::time::timeout(
            Duration::from_millis(200),
            manager.run("two", "test", None, &runtime_id),
        )
        .await;
        assert!(result
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("plugin.wasm.call"));
        std::fs::remove_dir_all(root).unwrap();
    }

    const WASM_STUB: &str = r#"
        (module
            (memory (export "memory") 5)
            (func (export "tunnelde_call") (param i32 i32 i32 i32) (result i32)
                (i32.const 0)))
    "#;

    fn write_wasm_plugin(dir: &Path, id: &str, module: &[u8]) {
        std::fs::create_dir_all(dir).expect("plugin dir");
        std::fs::write(dir.join("plugin.wasm"), module).expect("module");
        let manifest = format!(
            r#"{{"id":"{id}","name":"{id}","version":"0.1.0","apiVersion":1,"main":"plugin.wasm","runtime":"wasm"}}"#
        );
        std::fs::write(dir.join(manifest::MANIFEST_FILE), manifest).expect("manifest");
    }

    #[tokio::test]
    async fn loads_wasm_plugins_and_records_compile_errors() {
        let root = temp_root("wasm-load");
        write_wasm_plugin(&root.join("echo"), "echo", WASM_STUB.as_bytes());
        write_wasm_plugin(&root.join("broken"), "broken", b"not wasm");

        let manager = PluginsManager::load(root.clone());
        let list = manager.list().await;
        assert_eq!(list.len(), 2);

        let echo = list
            .iter()
            .find(|plugin| plugin.id == "echo")
            .expect("echo");
        assert_eq!(echo.status, PluginStatus::Stopped);
        assert!(echo.error.is_none());

        let broken = list
            .iter()
            .find(|plugin| plugin.id == "broken")
            .expect("broken");
        assert_eq!(broken.status, PluginStatus::Failed);
        assert!(broken
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("plugin.wasm.invalid"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
