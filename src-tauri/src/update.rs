use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock, RwLockWriteGuard};
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult, UpdateSourceFailure};
use crate::models::now_ms;
use crate::settings::Settings;
use crate::state::AppState;

mod atom;
mod channels;
mod feeds;
pub mod history;

use channels::accepts_version;
use feeds::{feeds, Feed};

pub const RELEASES_PAGE: &str = "https://github.com/TunneldeDev/Tunnelde/releases/latest";
const EVENT: &str = "update://state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    pub current_version: String,
    pub channel: String,
    pub source: String,
    pub source_url: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<i64>,
    pub progress: Option<u64>,
    pub content_length: Option<u64>,
    pub error: Option<String>,
    pub source_errors: Option<Vec<UpdateSourceFailure>>,
    pub last_checked: Option<i64>,
    pub available: bool,
    pub auto_install: bool,
    pub unsupported_reason: Option<String>,
    pub download_url: Option<String>,
    pub skipped: bool,
}

impl UpdateState {
    fn new(current_version: String, settings: &Settings) -> Self {
        Self {
            phase: Phase::Idle,
            current_version,
            channel: settings.update_channel.clone(),
            source: settings.update_source.clone(),
            source_url: settings.update_source_url.clone(),
            version: None,
            notes: None,
            published_at: None,
            progress: None,
            content_length: None,
            error: None,
            source_errors: None,
            last_checked: None,
            available: false,
            auto_install: false,
            unsupported_reason: None,
            download_url: None,
            skipped: false,
        }
    }

    fn matches(&self, settings: &Settings) -> bool {
        self.channel == settings.update_channel
            && self.source == settings.update_source
            && self.source_url == settings.update_source_url
    }
}

pub fn validate_settings_change(
    previous: &Settings,
    next: &Settings,
    snapshot: &UpdateState,
) -> AppResult<()> {
    if matches!(snapshot.phase, Phase::Downloading | Phase::Ready)
        && (previous.update_channel != next.update_channel
            || previous.update_source != next.update_source
            || previous.update_source_url != next.update_source_url)
    {
        return Err(AppError::validation("updates.installInProgress"));
    }
    Ok(())
}

pub struct UpdateService {
    state: RwLock<UpdateState>,
    // Retain the exact signed package selected by Check, rather than checking again at Install.
    pending: Mutex<Option<Update>>,
    busy: AtomicBool,
    github_api_backoff: feeds::ApiBackoff,
}

impl UpdateService {
    pub fn new(current_version: String) -> Self {
        Self {
            state: RwLock::new(UpdateState::new(current_version, &Settings::default())),
            pending: Mutex::new(None),
            busy: AtomicBool::new(false),
            github_api_backoff: feeds::ApiBackoff::default(),
        }
    }

    pub fn snapshot(&self) -> UpdateState {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn write(&self) -> RwLockWriteGuard<'_, UpdateState> {
        self.state
            .write()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, app: &AppHandle) {
        let _ = app.emit(EVENT, self.snapshot());
    }

    fn set_pending(&self, update: Option<Update>) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = update;
    }

    fn acquire(&self) -> Option<BusyGuard<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| BusyGuard(&self.busy))
    }

    fn fail(&self, app: &AppHandle, error: &AppError) {
        let failures = error.update_source_errors();
        tracing::warn!(
            reason = %error,
            source_errors = ?failures,
            action = "open_update_details_or_output",
            "application update failed"
        );
        {
            let mut guard = self.write();
            guard.phase = Phase::Error;
            guard.error = Some(error.to_string());
            guard.source_errors = failures;
        }
        self.publish(app);
    }
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct Capability {
    pub supported: bool,
    pub auto_install: bool,
    pub reason: &'static str,
}

pub fn capability() -> Capability {
    if cfg!(debug_assertions) {
        return Capability {
            supported: false,
            auto_install: false,
            reason: "dev",
        };
    }
    let (supported, auto_install, reason) = if cfg!(target_os = "windows") {
        (true, true, "")
    } else if cfg!(target_os = "macos") {
        (true, false, "unsigned")
    } else if cfg!(target_os = "linux") {
        if std::env::var_os("APPIMAGE").is_some() {
            (true, true, "")
        } else {
            (true, false, "package")
        }
    } else {
        (false, false, "unsupported")
    };
    Capability {
        supported,
        auto_install,
        reason,
    }
}

/// Custom sources serve ordinary Tauri manifests for both channels. No source may replace
/// the embedded verification key or disable HTTPS / package signature verification.
pub fn validate_preferences(settings: &Settings) -> AppResult<()> {
    if !["stable", "beta"].contains(&settings.update_channel.as_str()) {
        return Err(AppError::validation("updates.invalidChannel"));
    }
    if settings.update_source_url.is_empty() {
        return Ok(());
    }
    let template = &settings.update_source_url;
    if template.len() > 2048
        || template.matches("{channel}").count() != 1
        || template
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::validation("updates.invalidSource"));
    }
    let replaced = template.replace("{channel}", "tunnelde-update-channel");
    if replaced.contains(['{', '}', '\\']) {
        return Err(AppError::validation("updates.invalidSource"));
    }
    let url = reqwest::Url::parse(&replaced)
        .map_err(|_| AppError::validation("updates.invalidSource"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || !url.path().contains("tunnelde-update-channel")
        || url
            .host_str()
            .is_some_and(|host| host.contains("tunnelde-update-channel"))
    {
        return Err(AppError::validation("updates.invalidSource"));
    }
    Ok(())
}

fn configured_updater(
    app: &AppHandle,
    settings: &Settings,
    feed: &Feed,
) -> AppResult<tauri_plugin_updater::Updater> {
    let channel = feed.channel.clone();
    let version = feed.version.clone();
    let mut builder = app
        .updater_builder()
        .endpoints(vec![feed.url.clone()])?
        .version_comparator(move |current, release| {
            version
                .as_ref()
                .is_none_or(|version| version == &release.version)
                && accepts_version(&current, &release.version, &channel)
        })
        .configure_client(|builder| {
            builder
                .https_only(true)
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(60))
        });
    if let Some(url) = crate::network::proxy_url(&settings.network, "updates", None)? {
        builder = if url.is_empty() {
            builder.no_proxy()
        } else {
            builder.proxy(
                url.parse()
                    .map_err(|_| AppError::validation("network.invalid"))?,
            )
        };
    }
    builder
        .build()
        .map_err(|error| AppError::Update(error.to_string()))
}

async fn check_manifest(
    client: &reqwest::Client,
    updater: &tauri_plugin_updater::Updater,
    feed: &Feed,
) -> AppResult<Option<Update>> {
    let raw = if let Some(raw) = &feed.manifest {
        Some(raw.clone())
    } else {
        feeds::manifest(client, &feed.url).await?
    };
    let Some(raw) = raw else { return Ok(None) };
    // Keep Tauri's platform selection, comparator, runtime public key and signed-version
    // verification. Only HTTP transport is owned here, so status and bounded-body
    // diagnostics are not lost inside Updater::check().
    updater.restore_update(raw).map_err(|error| {
        let reason = match error {
            tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_) => "updates.platformUnavailable",
            _ => "updates.invalidFeed",
        };
        feeds::manifest_error(&feed.url, reason)
    })
}

pub async fn check(app: AppHandle, force: bool) -> AppResult<UpdateState> {
    let service = app.state::<AppState>();
    let Some(_busy) = service.update.acquire() else {
        return Ok(service.update.snapshot());
    };
    let result = tokio::time::timeout(Duration::from_secs(65), run_check(&app, force))
        .await
        .unwrap_or_else(|_| Err(AppError::Update("updates.timeout".into())));
    if let Err(error) = &result {
        service.update.fail(&app, error);
    }
    result
}

async fn run_check(app: &AppHandle, force: bool) -> AppResult<UpdateState> {
    let service = app.state::<AppState>();
    let settings = service.settings();
    let capability = capability();
    let mut next = UpdateState::new(service.update.snapshot().current_version, &settings);
    next.phase = Phase::Checking;
    service.update.set_pending(None);
    *service.update.write() = next.clone();
    service.update.publish(app);

    if !capability.supported {
        next.phase = Phase::Unsupported;
        next.unsupported_reason = Some(capability.reason.into());
        next.download_url = Some(RELEASES_PAGE.into());
    } else {
        let feeds = feeds(app, &settings).await?;
        let mut candidates = Vec::new();
        // At most three channel manifests; choose by SemVer, not publication date.
        let checks = feeds
            .iter()
            .map(|feed| configured_updater(app, &settings, feed))
            .collect::<AppResult<Vec<_>>>()?;
        let client = crate::network::http_client(app, "updates")?;
        let (first, second, third) = tokio::join!(
            check_manifest(&client, &checks[0], &feeds[0]),
            async {
                if checks.len() > 1 {
                    check_manifest(&client, &checks[1], &feeds[1]).await
                } else {
                    Ok(None)
                }
            },
            async {
                if checks.len() > 2 {
                    check_manifest(&client, &checks[2], &feeds[2]).await
                } else {
                    Ok(None)
                }
            }
        );
        for (index, result) in [first, second, third].into_iter().enumerate() {
            if let Some(mut update) = result? {
                if update.body.is_none() {
                    update.body = feeds[index].notes.clone();
                }
                if update.download_url.scheme() != "https" {
                    return Err(AppError::Update("updates.invalidFeed".into()));
                }
                let version = Version::parse(&update.version)
                    .map_err(|_| AppError::Update("updates.invalidFeed".into()))?;
                candidates.push((version, update, feeds[index].page.clone()));
            }
        }
        if let Some((_, update, page)) = candidates.into_iter().max_by(|a, b| a.0.cmp(&b.0)) {
            next.phase = Phase::Available;
            next.available = true;
            next.auto_install = capability.auto_install;
            next.download_url = Some(page);
            next.skipped =
                !force && settings.skipped_version.as_deref() == Some(update.version.as_str());
            next.version = Some(update.version.clone());
            next.notes = update.body.clone();
            next.published_at = update.date.map(|date| date.unix_timestamp() * 1000);
            service.update.set_pending(Some(update));
        } else {
            next.phase = Phase::UpToDate;
        }
        if !capability.auto_install {
            next.unsupported_reason = Some(capability.reason.into());
        }
    }
    next.last_checked = Some(now_ms());
    *service.update.write() = next;
    persist_last_check(app).await;
    service.update.publish(app);
    Ok(service.update.snapshot())
}

pub async fn install(app: AppHandle) -> AppResult<UpdateState> {
    let service = app.state::<AppState>();
    let Some(_busy) = service.update.acquire() else {
        return Ok(service.update.snapshot());
    };
    let result = run_install(&app).await;
    if let Err(error) = &result {
        service.update.fail(&app, error);
    }
    result
}

async fn run_install(app: &AppHandle) -> AppResult<UpdateState> {
    if !capability().auto_install {
        return Err(AppError::Update("updates.unsupportedOther".into()));
    }
    let service = app.state::<AppState>();
    let snapshot = service.update.snapshot();
    if !snapshot.matches(&service.settings()) || !snapshot.available {
        return Err(AppError::Update("updates.checkAgain".into()));
    }
    let update = service
        .update
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| AppError::Update("updates.checkAgain".into()))?;
    {
        let mut next = service.update.write();
        next.phase = Phase::Downloading;
        next.progress = Some(0);
        next.content_length = None;
        next.error = None;
    }
    service.update.publish(app);
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emitted = std::time::Instant::now();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let state = progress_app.state::<AppState>();
                {
                    let mut next = state.update.write();
                    next.progress = Some(downloaded);
                    if total.is_some() {
                        next.content_length = total;
                    }
                }
                if last_emitted.elapsed() >= Duration::from_millis(100) || total == Some(downloaded)
                {
                    state.update.publish(&progress_app);
                    last_emitted = std::time::Instant::now();
                }
            },
            || {},
        )
        .await?;
    // Download verifies the package before we change the recovery marker.
    // Windows installation exits directly; Linux returns and needs a restart.
    service
        .plugins
        .security
        .with_planned_restart(&service.db, || {
            update.install(bytes)?;
            {
                let mut next = service.update.write();
                next.phase = Phase::Ready;
                next.progress = next.content_length;
            }
            service.update.set_pending(None);
            service.update.publish(app);
            app.restart();
        })
}

pub fn release_page(settings: &Settings, snapshot: &UpdateState) -> String {
    if snapshot.matches(settings) {
        if let Some(url) = &snapshot.download_url {
            if url.starts_with("https://github.com/TunneldeDev/Tunnelde/releases/") {
                return url.clone();
            }
        }
    }
    if settings.update_channel != "stable" {
        "https://github.com/TunneldeDev/Tunnelde/releases".into()
    } else {
        RELEASES_PAGE.into()
    }
}

pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = check(app, true).await;
    });
}

fn auto_check_due(settings: &Settings, now: i64, startup: bool) -> bool {
    if !settings.auto_check_updates {
        return false;
    }
    let interval = match settings.update_check_interval.as_str() {
        "startup" => return startup,
        "weekly" => 7 * 24 * 60 * 60 * 1000,
        _ => 24 * 60 * 60 * 1000,
    };
    settings
        .last_update_check
        .is_none_or(|last| now < last || now.saturating_sub(last) >= interval)
}

pub fn spawn_auto_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if !capability().supported {
            return;
        }
        let mut startup = true;
        loop {
            let due = auto_check_due(&app.state::<AppState>().settings(), now_ms(), startup);
            if due {
                if let Err(error) = check(app.clone(), false).await {
                    tracing::debug!(%error, "automatic update check failed");
                }
            }
            startup = false;
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

async fn persist_last_check(app: &AppHandle) {
    if let Err(error) = crate::services::settings::record_update_check(app, now_ms()).await {
        tracing::warn!(%error, "failed to persist the update check timestamp");
    }
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
