use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use sysinfo::{Disks, System};
use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;

use crate::db::{self, Database};
use crate::error::{AppError, AppResult};
use crate::plugins::PluginsManager;
use crate::settings::Settings;
use crate::ssh::files::TransferRegistry;
use crate::ssh::monitor::MonitorCache;
use crate::ssh::SshManager;
use crate::update::UpdateService;

pub struct AppState {
    pub db: Database,
    pub settings: RwLock<Settings>,
    /// Serializes read/validate/persist/publish for every settings writer.
    pub(crate) settings_commit: tokio::sync::Mutex<()>,
    pub ui_provider_revision: AtomicU64,
    pub http_clients: crate::network::HttpClients,
    pub update: UpdateService,
    pub ssh: SshManager,
    pub forwards: crate::ssh::forward::ForwardRegistry,
    pub(crate) forward_starts: crate::services::forwarding::start::ManagerState,
    pub mounts: crate::mounts::MountRegistry,
    pub transfers: TransferRegistry,
    pub(crate) native_saves: std::sync::Arc<crate::ssh::files::native_save::runtime::Manager>,
    pub monitor: MonitorCache,
    pub plugins: PluginsManager,
    pub(crate) runners: crate::plugins::runners::Coordinator,
    pub downloads: crate::plugins::network::DownloadRegistry,
    pub locale: RwLock<String>,
    pub system: Mutex<System>,
    pub disks: Mutex<Disks>,
    pub data_dir: PathBuf,
    pub storage: crate::storage::layout::Paths,
    pub log_dir: PathBuf,
    _log_guard: Mutex<Option<WorkerGuard>>,
    // Last field: keep ownership until database, plugin and log state has dropped.
    _storage_lease: crate::storage::ownership::Lease,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn set_settings(&self, next: Settings) {
        let mut guard = self
            .settings
            .write()
            .unwrap_or_else(|error| error.into_inner());
        self.transfers.bandwidth.configure(
            next.transfer_upload_limit_kib,
            next.transfer_download_limit_kib,
        );
        if guard.ui_providers.get("forwarding") != next.ui_providers.get("forwarding") {
            self.ui_provider_revision.fetch_add(1, Ordering::SeqCst);
        }
        *guard = next;
    }

    pub fn locale(&self) -> String {
        self.locale
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn set_locale(&self, locale: impl Into<String>) {
        let mut guard = self
            .locale
            .write()
            .unwrap_or_else(|error| error.into_inner());
        *guard = locale.into();
    }
}

pub fn init(app: &AppHandle) -> AppResult<()> {
    let override_dir = std::env::var_os("TUNNELDE_DATA_DIR").map(PathBuf::from);
    let data_dir = match &override_dir {
        Some(path) => path.clone(),
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::internal(error.to_string()))?,
    };

    let log_dir = match &override_dir {
        Some(path) => path.join("logs"),
        None => app
            .path()
            .app_log_dir()
            .map_err(|error| AppError::internal(error.to_string()))?,
    };
    // Application identifiers do not protect a shared TUNNELDE_DATA_DIR.
    // Own it before reading config or allowing startup migration to touch files.
    let (storage, storage_lease) = crate::storage::ownership::initialize(
        data_dir.clone(),
        log_dir,
        std::env::var_os("TUNNELDE_PLUGINS_DIR").map(PathBuf::from),
    )?;
    let log_dir = storage
        .dir(crate::storage::layout::Category::Logs)
        .to_owned();
    let guard = crate::platform::logging::init(&log_dir)?;

    let db_path = storage
        .dir(crate::storage::layout::Category::Database)
        .join("tunnelde.db");
    let database = match Database::open(&db_path) {
        Ok(database) => database,
        Err(error) => {
            tracing::error!(%error, "database unavailable, recreating a fresh copy");
            quarantine(&db_path)?;
            Database::open(&db_path)?
        }
    };

    crate::storage::relocate_key_references(&database, &storage)?;
    let plugins_dir = storage
        .dir(crate::storage::layout::Category::Plugins)
        .to_owned();
    let _ = std::fs::create_dir_all(&plugins_dir);

    let settings = database.with(db::settings::load)?;
    let transfers = TransferRegistry::default();
    transfers.bandwidth.configure(
        settings.transfer_upload_limit_kib,
        settings.transfer_download_limit_kib,
    );
    let version = app.package_info().version.to_string();
    let native_saves = std::sync::Arc::new(crate::ssh::files::native_save::runtime::Manager::new(
        storage.dir(crate::storage::layout::Category::Database),
        &app.config().identifier,
    ));
    let plugins = PluginsManager::load(plugins_dir);
    plugins.initialize_security(
        &database,
        crate::plugins::security::cli_restricted(std::env::args()),
    )?;

    app.manage(AppState {
        db: database,
        settings: RwLock::new(settings),
        settings_commit: tokio::sync::Mutex::new(()),
        ui_provider_revision: AtomicU64::new(0),
        http_clients: Default::default(),
        update: UpdateService::new(version),
        ssh: SshManager::default(),
        forwards: crate::services::forwarding::registry(app),
        forward_starts: Default::default(),
        mounts: Default::default(),
        transfers,
        native_saves,
        monitor: MonitorCache::default(),
        plugins,
        runners: Default::default(),
        downloads: crate::plugins::network::DownloadRegistry::default(),
        locale: RwLock::new("en-US".into()),
        system: Mutex::new(System::new_all()),
        disks: Mutex::new(Disks::new_with_refreshed_list()),
        data_dir,
        storage,
        log_dir,
        _log_guard: Mutex::new(Some(guard)),
        _storage_lease: storage_lease,
    });

    Ok(())
}

/// Moves a corrupt database (and its WAL sidecars) aside instead of deleting
/// it, so a user can still recover data manually.
fn quarantine(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let suffix = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = path.with_extension(format!("corrupt-{suffix}.db"));
    std::fs::rename(path, &target)?;
    for sidecar in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{sidecar}", path.display()));
        if from.exists() {
            let to = PathBuf::from(format!("{}{sidecar}", target.display()));
            let _ = std::fs::rename(from, to);
        }
    }
    Ok(())
}
