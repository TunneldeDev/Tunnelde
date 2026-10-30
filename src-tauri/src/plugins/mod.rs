// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

mod host;
pub mod manifest;
pub mod marketplace;
pub mod wasm;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::plugins::host::PluginHost;
use crate::plugins::manifest::{PluginCommand, PluginManifest, PluginView};
use crate::plugins::wasm::WasmPlugin;

pub const STATE_EVENT: &str = "plugin://state";
const START_TIMEOUT: Duration = Duration::from_secs(8);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

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
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub description: Option<String>,
    pub commands: Vec<PluginCommand>,
    pub views: Vec<PluginView>,
    pub permissions: Vec<String>,
    pub status: PluginStatus,
    pub error: Option<String>,
    pub path: String,
}

struct Instance {
    manifest: PluginManifest,
    dir: PathBuf,
    status: PluginStatus,
    error: Option<String>,
    host: Option<PluginHost>,
    wasm: Option<WasmPlugin>,
}

impl Instance {
    fn new(manifest: PluginManifest, dir: PathBuf) -> Self {
        let mut instance = Self {
            manifest,
            dir,
            status: PluginStatus::Stopped,
            error: None,
            host: None,
            wasm: None,
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

    fn load_wasm(&self) -> AppResult<WasmPlugin> {
        let entry = manifest::entry_path(&self.dir, &self.manifest.main)?;
        let bytes = std::fs::read(entry)?;
        WasmPlugin::load(&bytes)
    }

    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone(),
            api_version: self.manifest.api_version,
            description: self.manifest.description.clone(),
            commands: self.manifest.commands.clone(),
            views: self.manifest.views.clone(),
            permissions: self.manifest.permissions.clone(),
            status: self.status,
            error: self.error.clone(),
            path: self.dir.to_string_lossy().into_owned(),
        }
    }
}

pub struct PluginsManager {
    dir: PathBuf,
    plugins: Mutex<HashMap<String, Instance>>,
}

impl PluginsManager {
    pub fn load(dir: PathBuf) -> Self {
        let mut plugins = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                match manifest::load(&path) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        plugins.insert(id, Instance::new(manifest, path));
                    }
                    Err(error) => {
                        tracing::warn!(%error, dir = %path.display(), "skipping plugin");
                    }
                }
            }
        }
        Self {
            dir,
            plugins: Mutex::new(plugins),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.dir
    }

    pub async fn list(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.lock().await;
        let mut list: Vec<PluginInfo> = plugins.values().map(Instance::info).collect();
        list.sort_by_key(|plugin| plugin.name.to_lowercase());
        list
    }
    pub async fn start(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        let mut plugins = self.plugins.lock().await;
        let instance = plugins
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;

        if instance.is_wasm() {
            // The module is preloaded when the plugin is scanned, but a stop
            // drops it, so reload on demand to keep start idempotent.
            if instance.wasm.is_none() {
                match instance.load_wasm() {
                    Ok(wasm) => instance.wasm = Some(wasm),
                    Err(error) => {
                        instance.status = PluginStatus::Failed;
                        instance.error = Some(error.to_string());
                        let info = instance.info();
                        drop(plugins);
                        let _ = app.emit(STATE_EVENT, &info);
                        return Ok(info);
                    }
                }
            }
            instance.status = PluginStatus::Running;
            instance.error = None;
            let info = instance.info();
            drop(plugins);
            let _ = app.emit(STATE_EVENT, &info);
            return Ok(info);
        }

        if instance.host.is_some() {
            return Ok(instance.info());
        }

        let node = std::env::var("TUNNELDE_NODE").unwrap_or_else(|_| "node".to_string());
        let entry = manifest::entry_path(&instance.dir, &instance.manifest.main)?;
        let host = PluginHost::spawn(&node, &entry, &instance.dir).await?;

        let initialized = host
            .request(
                "initialize",
                json!({
                    "apiVersion": manifest::API_VERSION,
                    "pluginId": instance.manifest.id,
                }),
                START_TIMEOUT,
            )
            .await;

        match initialized {
            Ok(_) => {
                instance.host = Some(host);
                instance.status = PluginStatus::Running;
                instance.error = None;
            }
            Err(error) => {
                let mut host = host;
                host.kill();
                instance.status = PluginStatus::Failed;
                instance.error = Some(error.to_string());
            }
        }

        let info = instance.info();
        drop(plugins);
        let _ = app.emit(STATE_EVENT, &info);
        Ok(info)
    }

    pub async fn stop(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        let mut plugins = self.plugins.lock().await;
        let instance = plugins
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;

        if let Some(mut host) = instance.host.take() {
            let _ = host
                .request("shutdown", json!({}), Duration::from_secs(2))
                .await;
            host.kill();
        }
        instance.wasm = None;
        instance.status = PluginStatus::Stopped;
        instance.error = None;

        let info = instance.info();
        drop(plugins);
        let _ = app.emit(STATE_EVENT, &info);
        Ok(info)
    }

    pub async fn render_view(&self, id: &str, view: &str) -> AppResult<Value> {
        let plugins = self.plugins.lock().await;
        let instance = plugins
            .get(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
        if instance.is_wasm() {
            return wasm_call(instance, json!({ "method": "render", "view": view }));
        }
        let host = instance
            .host
            .as_ref()
            .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?;

        host.request("view.render", json!({ "view": view }), CALL_TIMEOUT)
            .await
    }

    pub async fn run(&self, id: &str, command: &str) -> AppResult<Value> {
        let plugins = self.plugins.lock().await;
        let instance = plugins
            .get(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
        if instance.is_wasm() {
            return wasm_call(instance, json!({ "method": "run", "command": command }));
        }
        let host = instance
            .host
            .as_ref()
            .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?;

        host.request("command.run", json!({ "command": command }), CALL_TIMEOUT)
            .await
    }
}

/// Round-trips one request through a WASM plugin and parses its JSON answer.
fn wasm_call(instance: &Instance, request: Value) -> AppResult<Value> {
    let wasm = instance
        .wasm
        .as_ref()
        .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?;
    let payload = serde_json::to_string(&request)?;
    let response = wasm
        .call(&payload)
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
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
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

impl PluginsManager {
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
        let manifest = manifest::load(root)?;
        let target = self.dir.join(&manifest.id);
        if target.exists() {
            return Err(AppError::validation("plugin.exists"));
        }

        copy_dir(root, &target)?;
        let copied = match manifest::load(&target) {
            Ok(copied) => copied,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&target);
                return Err(error);
            }
        };

        let instance = Instance::new(copied, target);
        let info = instance.info();
        self.plugins.lock().await.insert(info.id.clone(), instance);
        Ok(info)
    }

    pub async fn uninstall(&self, id: &str) -> AppResult<()> {
        let mut plugins = self.plugins.lock().await;
        let mut instance = plugins
            .remove(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
        if let Some(mut host) = instance.host.take() {
            host.kill();
        }
        drop(plugins);

        std::fs::remove_dir_all(&instance.dir)?;
        Ok(())
    }

    pub async fn reload(&self) -> Vec<PluginInfo> {
        let mut plugins = self.plugins.lock().await;
        for instance in plugins.values_mut() {
            if let Some(mut host) = instance.host.take() {
                host.kill();
            }
        }
        let fresh = Self::load(self.dir.clone()).plugins.into_inner();
        *plugins = fresh;
        let mut list: Vec<PluginInfo> = plugins.values().map(Instance::info).collect();
        list.sort_by_key(|plugin| plugin.name.to_lowercase());
        list
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
