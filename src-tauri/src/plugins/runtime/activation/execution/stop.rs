use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::plugins::{tasks, PluginInfo, PluginStatus, PluginsManager, STATE_EVENT};

impl PluginsManager {
    pub async fn stop(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        self.security.invalidate_runtime(id);
        tasks::cancel_plugin(id, None);
        self.stop_network_resources(app, id);
        self.stop_remote_runners(app, id);
        self.remember_source(id, None);
        let handle = self.instance(id).await?;
        let mut instance = handle.lock().await;
        if instance.retired {
            return Err(AppError::NotFound("plugin.notFound".into()));
        }

        if let Some(mut host) = instance.host.take() {
            let _ = host
                .request("shutdown", json!({}), Duration::from_secs(2))
                .await;
            host.kill();
        }
        instance.wasm = None;
        instance.node_source = None;
        instance.status = PluginStatus::Stopped;
        instance.error = None;

        let info = instance.info();
        self.remember(&info);
        drop(instance);
        let _ = app.emit(STATE_EVENT, &info);
        Ok(info)
    }

    pub async fn stop_immediately(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        self.security.invalidate_runtime(id);
        tasks::cancel_plugin(id, None);
        self.stop_network_resources(app, id);
        self.stop_remote_runners(app, id);
        self.remember_source(id, None);
        let handle = self.instance(id).await?;
        let mut instance = handle.lock().await;
        if let Some(mut host) = instance.host.take() {
            host.kill();
        }
        instance.wasm = None;
        instance.node_source = None;
        instance.status = PluginStatus::Stopped;
        instance.error = None;
        let info = instance.info();
        self.remember(&info);
        drop(instance);
        let _ = app.emit(STATE_EVENT, &info);
        Ok(info)
    }

    pub async fn stop_all_immediately(&self, app: &AppHandle) {
        let ids: Vec<_> = self.plugins.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop_immediately(app, &id).await;
        }
    }

    pub async fn stop_system_nodes(&self, app: &AppHandle) {
        let ids: Vec<_> = self
            .runtime_sources
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, source)| {
                matches!(
                    source.as_str(),
                    "environment" | "path" | "registry" | "shell"
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.security.invalidate_runtime(&id);
            self.revoke_background(app, &id);
            self.remember_source(&id, None);
            let Ok(handle) = self.instance(&id).await else {
                continue;
            };
            let mut instance = handle.lock().await;
            if !matches!(
                instance.node_source.as_deref(),
                Some("environment" | "path" | "registry" | "shell")
            ) {
                continue;
            }
            if let Some(mut host) = instance.host.take() {
                host.kill();
            }
            instance.node_source = None;
            self.remember_source(&id, None);
            instance.status = PluginStatus::Stopped;
            instance.error = None;
            let info = instance.info();
            self.remember(&info);
            drop(instance);
            let _ = app.emit(STATE_EVENT, info);
        }
    }
}
