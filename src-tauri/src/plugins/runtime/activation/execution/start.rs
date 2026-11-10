use std::path::Path;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::plugins::{
    api, config, host::PluginHost, manifest, node, security, PluginInfo, PluginStatus,
    PluginsManager, STATE_EVENT,
};

const START_TIMEOUT: Duration = Duration::from_secs(8);

impl PluginsManager {
    pub async fn start(&self, app: &AppHandle, id: &str) -> AppResult<PluginInfo> {
        let handle = self.instance(id).await?;
        let mut instance = handle.lock().await;
        if instance.retired {
            return Err(AppError::NotFound("plugin.notFound".into()));
        }
        instance.require_runtime()?;
        if let Some(frontend) = &instance.manifest.frontend {
            frontend.require_sdk()?;
            let _ = self.frontend_app.set(app.clone());
        }
        let lease = self.security.lease(
            id,
            security::fingerprint_async(instance.dir.clone()).await?,
            instance.manifest.permissions.clone(),
        )?;
        let state = app.state::<crate::state::AppState>();
        self.security.mark_running(&state.db)?;

        if matches!(
            instance.manifest.runtime.as_deref(),
            Some("declarative" | "frontend")
        ) {
            instance.status = PluginStatus::Running;
            instance.error = None;
            let info = instance.info();
            self.remember(&info);
            drop(instance);
            let _ = app.emit(STATE_EVENT, &info);
            return Ok(info);
        }

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
                        self.remember(&info);
                        drop(instance);
                        let _ = app.emit(STATE_EVENT, &info);
                        return Ok(info);
                    }
                }
            }
            instance.status = PluginStatus::Running;
            instance.error = None;
            let info = instance.info();
            self.remember(&info);
            drop(instance);
            let _ = app.emit(STATE_EVENT, &info);
            return Ok(info);
        }

        if instance.host.is_some() {
            return Ok(instance.info());
        }

        let config = state.db.with(config::load)?;
        let runtime = self
            .security
            .guard(
                &lease,
                node::resolve(
                    state
                        .storage
                        .dir(crate::storage::layout::Category::Runtimes),
                    config.node_path.as_deref().map(Path::new),
                    config.node_system_allowed,
                ),
            )
            .await
            .inspect_err(|_| {
                self.remember_source(id, None);
            })?;
        if !runtime.compatible {
            return Err(AppError::validation("node.required"));
        }
        let node = runtime
            .path
            .ok_or_else(|| AppError::validation("node.required"))?;
        if let Some(range) = instance.manifest.engines.get("node") {
            let version = runtime
                .version
                .as_deref()
                .and_then(|value| semver::Version::parse(value.trim_start_matches('v')).ok());
            if !version.is_some_and(|version| {
                semver::VersionReq::parse(range).is_ok_and(|req| req.matches(&version))
            }) {
                return Err(AppError::validation("node.incompatible"));
            }
        }
        let entry = manifest::entry_path(&instance.dir, &instance.manifest.main)?;
        self.remember_source(id, runtime.source.clone());
        if matches!(
            runtime.source.as_deref(),
            Some("environment" | "path" | "registry" | "shell")
        ) && !state.db.with(config::load)?.node_system_allowed
        {
            self.remember_source(id, None);
            return Err(AppError::validation("node.required"));
        }
        self.security
            .authorize(
                id,
                &lease.fingerprint,
                &lease.permissions,
                None,
                Some(lease.generation),
            )
            .inspect_err(|_| self.remember_source(id, None))?;
        let host = self
            .security
            .guard(
                &lease,
                PluginHost::spawn(
                    &node,
                    &entry,
                    &instance.dir,
                    Some(api::HostContext {
                        app: app.clone(),
                        id: id.into(),
                        fingerprint: lease.fingerprint.clone(),
                        permissions: lease.permissions.clone(),
                        generation: lease.generation,
                        tool_client: None,
                        tool_request: None,
                    }),
                ),
            )
            .await
            .inspect_err(|_| self.remember_source(id, None))?;

        let initialized = self
            .security
            .guard(
                &lease,
                host.request(
                    "initialize",
                    json!({
                        "apiVersion": manifest::API_VERSION,
                        "pluginId": instance.manifest.id,
                        "permissions": instance.manifest.permissions,
                        "hostApiVersion": 1,
                    }),
                    START_TIMEOUT,
                ),
            )
            .await;

        if let Err(error) = self.security.authorize(
            id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        ) {
            let mut host = host;
            host.kill();
            self.remember_source(id, None);
            instance.status = PluginStatus::Stopped;
            instance.error = None;
            let info = instance.info();
            self.remember(&info);
            drop(instance);
            let _ = app.emit(STATE_EVENT, &info);
            return Err(error);
        }

        match initialized {
            Ok(_) => {
                instance.host = Some(host);
                instance.node_source = runtime.source;
                instance.status = PluginStatus::Running;
                instance.error = None;
            }
            Err(error) => {
                let detail = error.to_string();
                let reason = detail.split(':').next().unwrap_or("plugin.error");
                tracing::warn!(plugin_id = %id, reason, "plugin initialization failed");
                let mut host = host;
                host.kill();
                self.remember_source(id, None);
                instance.status = PluginStatus::Failed;
                instance.error = Some(error.to_string());
            }
        }

        let info = instance.info();
        self.remember(&info);
        drop(instance);
        let _ = app.emit(STATE_EVENT, &info);
        Ok(info)
    }
}
