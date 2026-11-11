//! The policy lock captures revocation boundaries; domain services own cleanup.
//! Workers may finish after a restart and must never re-read a newer boundary.
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::AppResult,
    plugins::{
        api::HostContext, contributions, runners, security::RuntimeRetirement, sessions, tasks,
        Instance, PluginInfo, PluginStatus, PluginsManager, STATE_EVENT,
    },
    state::AppState,
};

pub(in crate::plugins) enum StopMode {
    Graceful,
    Immediate,
    Retired,
}

impl PluginsManager {
    /// Caller holds the package write lock. Keep every Instance authoritative
    /// until all local processes have exited, including when cleanup fails.
    pub(in crate::plugins) async fn quiesce_catalogue(&self) -> AppResult<()> {
        let handles: Vec<_> = self.plugins.lock().await.values().cloned().collect();
        for handle in &handles {
            let mut instance = handle.lock().await;
            if let Err(error) = instance.terminate_host().await {
                instance.status = PluginStatus::Failed;
                instance.error = Some(error.to_string());
                self.remember(&instance.info());
                return Err(error);
            }
            instance.wasm = None;
            instance.node_source = None;
            instance.status = PluginStatus::Stopped;
            instance.error = None;
            self.remember(&instance.info());
        }
        for handle in handles {
            handle.lock().await.retired = true;
        }
        Ok(())
    }

    pub(in crate::plugins) fn cleanup_policy_retirement(&self, retired: Vec<RuntimeRetirement>) {
        if let Some(app) = self.runtime_app.get() {
            self.cleanup_retired(app, retired);
        }
    }

    pub(in crate::plugins) fn invalidate_plugin(&self, id: &str) {
        self.cleanup_policy_retirement(self.security.remove_grant(id));
    }
    pub fn revoke_background(&self, app: &AppHandle, id: &str) {
        self.cleanup_retired(app, self.security.retire_runtime(id));
    }

    pub(in crate::plugins) fn cleanup_retired(
        &self,
        app: &AppHandle,
        retired: Vec<RuntimeRetirement>,
    ) {
        for retirement in retired {
            self.cleanup_resources(app, &retirement);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = app
                    .state::<AppState>()
                    .plugins
                    .stop_captured(&app, &retirement, StopMode::Retired)
                    .await;
            });
        }
    }

    pub(in crate::plugins) fn cleanup_resources(
        &self,
        app: &AppHandle,
        retirement: &RuntimeRetirement,
    ) {
        let id = &retirement.id;
        let boundary = retirement.before_generation;
        self.profile_drafts.retire_before(id, boundary);
        tasks::cancel_before_generation(id, boundary);
        contributions::remove_runtime(app, id, |generation| generation < boundary);
        sessions::remove_runtime(app, id, |generation| generation < boundary);
        let state = app.state::<AppState>();
        state.transfers.cancel_plugin_before(id, boundary);
        state.forwards.stop_before_generation(id, boundary);
        let context = HostContext {
            app: app.clone(),
            id: id.clone(),
            fingerprint: String::new(),
            permissions: vec![],
            generation: boundary,
            tool_client: None,
            tool_request: None,
        };
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn(async move {
            app.state::<AppState>()
                .mounts
                .stop_before_generation(&id, boundary)
                .await;
        });
        tauri::async_runtime::spawn(async move {
            runners::revoke_before(&context, boundary).await;
        });
    }

    pub(in crate::plugins) async fn stop_captured(
        &self,
        app: &AppHandle,
        retirement: &RuntimeRetirement,
        mode: StopMode,
    ) -> AppResult<PluginInfo> {
        let handle = self.instance(&retirement.id).await?;
        let mut instance = handle.lock().await;
        if !instance.belongs_to_retirement(retirement) {
            return Ok(instance.info());
        }
        if let Some(host) = instance.host.as_ref() {
            if matches!(mode, StopMode::Graceful) {
                let _ = host
                    .request("shutdown", json!({}), Duration::from_secs(2))
                    .await;
            }
        }
        if let Err(error) = instance.terminate_host().await {
            instance.status = PluginStatus::Failed;
            instance.error = Some(error.to_string());
            let info = instance.info();
            self.remember(&info);
            let _ = app.emit(STATE_EVENT, &info);
            return Err(error);
        }
        instance.wasm = None;
        instance.node_source = None;
        if !matches!(mode, StopMode::Retired) || instance.status != PluginStatus::Failed {
            instance.status = PluginStatus::Stopped;
            instance.error = None;
        }
        self.remember_source(&retirement.id, None);
        let info = instance.info();
        self.remember(&info);
        let _ = app.emit(STATE_EVENT, &info);
        drop(instance);
        Ok(info)
    }
}

impl Instance {
    /// Retain Child in its authoritative slot across waits/cancellation. Only a
    /// confirmed local process exit releases the engine's ownership.
    pub(in crate::plugins) async fn terminate_host(&mut self) -> AppResult<()> {
        if let Some(host) = self.host.as_mut() {
            host.terminate().await?;
        }
        self.host = None;
        Ok(())
    }
}
