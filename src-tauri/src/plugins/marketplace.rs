use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::plugins::PluginInfo;
use crate::state::AppState;

const MAX_ARCHIVE: usize = 64 * 1024 * 1024;

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Installs an archive that the webview downloaded. The checksum pinned in the
/// catalogue must match, so a tampered download is refused before unpacking.
pub async fn install_archive(
    app: &AppHandle,
    id: &str,
    sha256: &str,
    data: &str,
) -> AppResult<PluginInfo> {
    if !super::manifest::valid_id(id) {
        return Err(AppError::validation("marketplace.invalidId"));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::validation("marketplace.invalidChecksum"));
    }
    if data.len() > MAX_ARCHIVE * 4 / 3 + 4 {
        return Err(AppError::validation("plugin.archive.tooLarge"));
    }

    let bytes = BASE64
        .decode(data)
        .map_err(|_| AppError::validation("marketplace.invalidArchive"))?;
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE {
        return Err(AppError::validation("plugin.archive.tooLarge"));
    }
    let actual = digest(&bytes);
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(AppError::validation("marketplace.checksumMismatch"));
    }

    let state = app.state::<AppState>();
    let directory = state.data_dir.join("tmp");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}-{}.zip", uuid::Uuid::new_v4()));
    std::fs::write(&path, &bytes)?;
    let outcome = async {
        let manifest = super::inspect(path.to_string_lossy().as_ref())?;
        if manifest.id != id {
            return Err(AppError::validation("market.identityMismatch"));
        }
        state.plugins.install(path.to_string_lossy().as_ref()).await
    }
    .await;
    let _ = std::fs::remove_file(&path);
    outcome
}

pub const ORIGIN_FILE: &str = ".tunnelde-origin.json";

pub fn origin(path: &Path) -> Option<super::config::MarketSource> {
    let mut bytes = Vec::new();
    std::fs::File::open(path.join(ORIGIN_FILE))
        .ok()?
        .take(8193)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    let mut source = serde_json::from_slice(&bytes).ok()?;
    super::config::migrate_official_source(&mut source);
    Some(source)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub readme: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub api_version: Option<u32>,
    #[serde(default)]
    pub engines: std::collections::BTreeMap<String, String>,
}

impl MarketEntry {
    fn valid(&self) -> bool {
        super::manifest::valid_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.len() <= 160
            && super::manifest::normalized_version(&self.version).is_some()
            && self.sha256.len() == 64
            && self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            && super::network::validate_url(&self.url).is_ok()
            && self.description.as_ref().is_none_or(|s| s.len() <= 4000)
            && self.readme.as_ref().is_none_or(|s| s.len() <= 100_000)
            && self.author.as_ref().is_none_or(|s| s.len() <= 160)
            && self
                .runtime
                .as_deref()
                .is_none_or(|runtime| matches!(runtime, "node" | "wasm" | "theme" | "declarative"))
            && self.engines.len() <= 8
            && self
                .engines
                .iter()
                .all(|(key, value)| key.len() <= 64 && value.len() <= 160)
            && self
                .engines
                .get("node")
                .is_none_or(|range| semver::VersionReq::parse(range).is_ok())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    pub source: super::config::MarketSource,
    pub entries: Vec<MarketEntry>,
    pub checked_at: i64,
    pub stale: bool,
    pub error: Option<String>,
}

fn cache_path(data_dir: &Path, source: &super::config::MarketSource) -> PathBuf {
    data_dir
        .join("marketplace")
        .join(format!("{}.json", source.id))
}

fn read_cached(data_dir: &Path, source: &super::config::MarketSource) -> Option<Catalogue> {
    if !super::manifest::valid_id(&source.id) {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(cache_path(data_dir, source))
        .ok()?
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    let mut value: Catalogue = serde_json::from_slice(&bytes).ok()?;
    if value.source.id != source.id
        || value.source.url != source.url
        || value.checked_at < 0
        || value.checked_at > crate::models::now_ms()
        || value.entries.len() > 2000
    {
        return None;
    }
    let mut ids = std::collections::HashSet::new();
    if !value
        .entries
        .iter()
        .all(|entry| entry.valid() && ids.insert(&entry.id))
    {
        return None;
    }
    value.source = source.clone();
    Some(value)
}

fn fresh(catalogue: &Catalogue, now: i64) -> bool {
    !catalogue.stale
        && catalogue.error.is_none()
        && catalogue.checked_at <= now
        && now.saturating_sub(catalogue.checked_at) < 5 * 60_000
}

pub async fn catalogue(
    app: &AppHandle,
    data_dir: &Path,
    source: &super::config::MarketSource,
    refresh: bool,
) -> AppResult<Catalogue> {
    let path = cache_path(data_dir, source);
    if !super::manifest::valid_id(&source.id) {
        return Err(AppError::validation("market.invalidSource"));
    }
    let cached = read_cached(data_dir, source);
    if !refresh {
        if let Some(c) = &cached {
            if fresh(c, crate::models::now_ms()) {
                return Ok(c.clone());
            }
        }
    }
    let result =
        super::network::fetch_json::<serde_json::Value>(app, &source.url, 2 * 1024 * 1024).await;
    match result.and_then(|payload| parse_catalogue(payload, source)) {
        Ok(c) => {
            // A read-only/full cache must not turn a successful online lookup
            // into a marketplace error.
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            if std::fs::write(&temporary, serde_json::to_vec(&c)?).is_ok() {
                // Cache is disposable; replacement failure must not hide a valid online catalogue.
                let _ = std::fs::rename(&temporary, &path);
                let _ = std::fs::remove_file(&temporary);
            }
            Ok(c)
        }
        Err(error) => {
            if let Some(mut cached) = cached {
                cached.stale = true;
                cached.error = Some(error.to_string());
                Ok(cached)
            } else {
                Err(error)
            }
        }
    }
}

fn parse_catalogue(
    payload: serde_json::Value,
    source: &super::config::MarketSource,
) -> AppResult<Catalogue> {
    let list = payload
        .get("plugins")
        .and_then(|p| p.as_array())
        .ok_or_else(|| AppError::validation("market.invalidCatalogue"))?;
    if list.len() > 2000 {
        return Err(AppError::validation("market.tooLarge"));
    }
    let mut ids = std::collections::HashSet::new();
    let entries = list
        .iter()
        .filter_map(|value| serde_json::from_value::<MarketEntry>(value.clone()).ok())
        .filter(|entry| entry.valid() && ids.insert(entry.id.clone()))
        .collect();
    Ok(Catalogue {
        source: source.clone(),
        entries,
        checked_at: crate::models::now_ms(),
        stale: false,
        error: None,
    })
}

pub async fn install_remote(
    app: &AppHandle,
    source_id: &str,
    id: &str,
    version: &str,
    checksum: &str,
    task_id: &str,
    update: bool,
) -> AppResult<PluginInfo> {
    let state = app.state::<AppState>();
    let source = state
        .db
        .with(super::config::load)?
        .sources
        .into_iter()
        .find(|source| source.id == source_id && source.enabled)
        .ok_or_else(|| AppError::validation("market.sourceDisabled"))?;
    let task = super::network::DownloadTask::begin(app, task_id)?;
    let catalogue = tokio::select! {
        result = catalogue(app, &state.data_dir, &source, false) => result?,
        _ = task.wait_cancel() => return Err(AppError::validation("market.cancelled")),
    };
    task.check()?;
    let entry = catalogue
        .entries
        .into_iter()
        .find(|entry| {
            entry.id == id
                && entry.version == version
                && entry.sha256.eq_ignore_ascii_case(checksum)
        })
        .ok_or_else(|| AppError::validation("market.entryChanged"))?;
    let bytes = task.download(&entry.url, MAX_ARCHIVE).await?;
    if !digest(&bytes).eq_ignore_ascii_case(&entry.sha256) {
        return Err(AppError::validation("marketplace.checksumMismatch"));
    }
    task.progress("verifying", bytes.len() as u64, Some(bytes.len() as u64));
    let directory = state
        .plugins
        .directory()
        .join(format!(".install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let archive = directory.join("package.zip");
    let extracted = directory.join("package");
    let result = async {
        std::fs::write(&archive, &bytes)?;
        super::extract_archive(&archive, &extracted)?;
        let root = super::locate_manifest_dir(&extracted)?;
        let manifest = super::manifest::load(&root)?;
        validate_identity(&entry, &manifest)?;
        if !state
            .db
            .with(super::config::load)?
            .sources
            .iter()
            .any(|current| current.enabled && current.id == source.id && current.url == source.url)
        {
            return Err(AppError::validation("market.sourceDisabled"));
        }
        task.check()?;
        task.progress("installing", 0, None);
        let info = state.plugins.install_market(&root, &source, update).await?;
        if update {
            state.plugins.revoke_background(app, &info.id);
        }
        task.progress("done", bytes.len() as u64, Some(bytes.len() as u64));
        Ok(info)
    }
    .await;
    let _ = std::fs::remove_dir_all(&directory);
    result
}

fn validate_identity(
    entry: &MarketEntry,
    manifest: &super::manifest::PluginManifest,
) -> AppResult<()> {
    if manifest.id != entry.id
        || manifest.version != entry.version
        || entry
            .runtime
            .as_ref()
            .is_some_and(|runtime| manifest.runtime.as_deref().unwrap_or("node") != runtime)
        || entry
            .api_version
            .is_some_and(|version| manifest.api_version != version)
        || !entry
            .engines
            .iter()
            .all(|(key, value)| manifest.engines.get(key) == Some(value))
    {
        return Err(AppError::validation("market.identityMismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_hex_sha256() {
        let value = digest(b"abc");
        assert_eq!(value.len(), 64);
        assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
        // Known SHA-256 of "abc".
        assert_eq!(
            value,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn catalogue_validates_identity_urls_versions_and_duplicate_ids() {
        let good = serde_json::json!({"id":"tool", "name":"Tool", "version":"1.0.0", "url":"https://example.org/tool.zip", "sha256":"a".repeat(64)});
        let mut bad_version = good.clone();
        bad_version["version"] = "not-a-version".into();
        let mut invalid = good.clone();
        invalid["id"] = "../escape".into();
        let result = parse_catalogue(
            serde_json::json!({"plugins":[invalid, good.clone(), good, bad_version]}),
            &super::super::config::official(),
        );
        assert_eq!(result.unwrap().entries.len(), 1);
        assert!(parse_catalogue(serde_json::json!({}), &super::super::config::official()).is_err());
    }

    fn test_catalogue() -> Catalogue {
        parse_catalogue(serde_json::json!({"plugins":[{"id":"tool", "name":"Tool", "version":"1.0.0", "url":"https://example.org/tool.zip", "sha256":"a".repeat(64)}]}), &super::super::config::official()).unwrap()
    }

    #[test]
    fn downloaded_manifest_must_match_pinned_catalogue_identity_and_runtime() {
        let mut entry = test_catalogue().entries.remove(0);
        entry.runtime = Some("node".into());
        entry.api_version = Some(1);
        entry.engines.insert("node".into(), ">=22".into());
        let manifest: super::super::manifest::PluginManifest = serde_json::from_value(serde_json::json!({"id":"tool","name":"Tool","version":"1.0.0","apiVersion":1,"main":"index.js","engines":{"node":">=22"}})).unwrap();
        validate_identity(&entry, &manifest).unwrap();
        for field in ["id", "version", "runtime", "apiVersion", "engines"] {
            let mut bad = serde_json::to_value(&manifest).unwrap();
            bad[field] = match field {
                "id" => "other".into(),
                "version" => "1.1.0".into(),
                "runtime" => "wasm".into(),
                "apiVersion" => 2.into(),
                _ => serde_json::json!({"node":">=26"}),
            };
            let changed = serde_json::from_value(bad).unwrap();
            assert!(validate_identity(&entry, &changed).is_err(), "{field}");
        }
    }

    #[test]
    fn theme_catalogue_entries_keep_manifest_identity_checks() {
        let catalogue = parse_catalogue(serde_json::json!({"plugins":[{"id":"colors", "name":"Colors", "version":"1.0.0", "runtime":"theme",
            "apiVersion":1, "url":"https://example.org/colors.zip", "sha256":"a".repeat(64)}]}), &super::super::config::official()).unwrap();
        let entry = &catalogue.entries[0];
        assert_eq!(entry.runtime.as_deref(), Some("theme"));
        let mut manifest: super::super::manifest::PluginManifest = serde_json::from_value(serde_json::json!({"id":"colors", "name":"Colors", "version":"1.0.0", "apiVersion":1,
            "runtime":"theme", "themes":[{"id":"blue", "name":"Blue", "appearance":"dark", "colors":{"background":"#000000"}}]})).unwrap();
        validate_identity(entry, &manifest).unwrap();
        manifest.runtime = Some("node".into());
        assert!(validate_identity(entry, &manifest).is_err());
        manifest.runtime = Some("theme".into());
        manifest.version = "2.0.0".into();
        assert!(validate_identity(entry, &manifest).is_err());
    }

    #[test]
    fn cache_rejects_corruption_foreign_sources_and_duplicate_entries() {
        let root = std::env::temp_dir().join(format!("tunnelde-cache-{}", uuid::Uuid::new_v4()));
        let mut catalogue = test_catalogue();
        let source = catalogue.source.clone();
        let path = cache_path(&root, &source);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "broken").unwrap();
        assert!(read_cached(&root, &source).is_none());
        std::fs::write(&path, serde_json::to_vec(&catalogue).unwrap()).unwrap();
        assert_eq!(read_cached(&root, &source).unwrap().entries.len(), 1);
        let changed = super::super::config::MarketSource {
            url: "https://example.org/new-source.json".into(),
            ..source.clone()
        };
        assert!(read_cached(&root, &changed).is_none());
        catalogue.entries.push(catalogue.entries[0].clone());
        std::fs::write(&path, serde_json::to_vec(&catalogue).unwrap()).unwrap();
        assert!(read_cached(&root, &source).is_none());
        catalogue.entries.pop();
        catalogue.source.id = "foreign".into();
        std::fs::write(&path, serde_json::to_vec(&catalogue).unwrap()).unwrap();
        assert!(read_cached(&root, &source).is_none());
        std::fs::write(&path, vec![b' '; 2 * 1024 * 1024 + 1]).unwrap();
        assert!(read_cached(&root, &source).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_freshness_never_accepts_stale_error_or_future_timestamp() {
        let mut catalogue = test_catalogue();
        let now = catalogue.checked_at;
        assert!(fresh(&catalogue, now));
        assert!(!fresh(&catalogue, now + 5 * 60_000));
        assert!(!fresh(&catalogue, now - 1));
        catalogue.stale = true;
        assert!(!fresh(&catalogue, now));
        catalogue.stale = false;
        catalogue.error = Some("offline".into());
        assert!(!fresh(&catalogue, now));
    }
}
