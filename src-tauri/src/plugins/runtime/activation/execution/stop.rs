use tauri::AppHandle;

use super::cleanup::StopMode;
use crate::error::{AppError, AppResult};
use crate::plugins::{PluginInfo, PluginsManager};

impl PluginsManager {
    pub async fn stop(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        self.stop_runtime(app, id, true).await
    }

    pub async fn stop_immediately(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        self.stop_runtime(app, id, false).await
    }

    async fn stop_runtime(
        &self,
        app: &AppHandle,
        id: &str,
        graceful: bool,
    ) -> AppResult<PluginInfo> {
        if !crate::plugins::manifest::valid_id(id) {
            return Err(AppError::NotFound("plugin.notFound".into()));
        }
        let retired = self.security.retire_runtime(id);
        let (mut owner, mut consumers) = (None, Vec::new());
        for retirement in retired {
            if retirement.id == id {
                owner = Some(retirement);
            } else {
                consumers.push(retirement);
            }
        }
        self.cleanup_retired(app, consumers);
        let owner = owner.expect("retirement always includes requested owner");
        self.cleanup_resources(app, &owner);
        self.stop_captured(
            app,
            &owner,
            if graceful {
                StopMode::Graceful
            } else {
                StopMode::Immediate
            },
        )
        .await
    }

    pub async fn stop_all_immediately(&self, app: &AppHandle) {
        self.starts.cancel_all();
        let ids: Vec<_> = self.plugins.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop_immediately(app, &id).await;
        }
    }

    pub async fn stop_system_nodes(&self, app: &AppHandle) {
        let leases: Vec<_> = self
            .runtime_sources
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, (source, _))| {
                matches!(
                    source.as_str(),
                    "environment" | "path" | "registry" | "shell"
                )
            })
            .map(|(_, (_, lease))| lease.clone())
            .collect();
        for lease in leases {
            let retired = self.security.retire_lease(&lease);
            for retirement in retired {
                self.cleanup_resources(app, &retirement);
                let _ = self
                    .stop_captured(app, &retirement, StopMode::Immediate)
                    .await;
            }
        }
    }
}
