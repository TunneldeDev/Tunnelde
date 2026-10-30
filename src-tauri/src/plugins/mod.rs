// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

mod host;
pub mod manifest;

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
}

impl Instance {
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
                        plugins.insert(
                            manifest.id.clone(),
                            Instance {
                                manifest,
                                dir: path,
                                status: PluginStatus::Stopped,
                                error: None,
                                host: None,
                            },
                        );
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
        let host = instance
            .host
            .as_ref()
            .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?;

        host.request("command.run", json!({ "command": command }), CALL_TIMEOUT)
            .await
    }
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

impl PluginsManager {
    pub async fn install(&self, source: &str) -> AppResult<PluginInfo> {
        let source = PathBuf::from(source);
        let manifest = manifest::load(&source)?;
        let target = self.dir.join(&manifest.id);
        if target.exists() {
            return Err(AppError::validation("plugin.exists"));
        }

        copy_dir(&source, &target)?;
        let copied = match manifest::load(&target) {
            Ok(copied) => copied,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&target);
                return Err(error);
            }
        };

        let instance = Instance {
            manifest: copied,
            dir: target,
            status: PluginStatus::Stopped,
            error: None,
            host: None,
        };
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
        std::fs::write(
            dir.join(manifest::MANIFEST_FILE),
            r#"{"id":"demo","name":"Demo","version":"0.1.0","apiVersion":1,"main":"index.js"}"#,
        )
        .expect("manifest");
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
}
