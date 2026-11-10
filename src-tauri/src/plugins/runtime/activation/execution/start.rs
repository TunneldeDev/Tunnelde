use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::plugins::{
    api, host::PluginHost, manifest, security, PluginInfo, PluginStatus, PluginsManager,
    STATE_EVENT,
};

use super::{
    execute::PreparedPackage,
    preflight::{self, PreparedEngine},
};

const START_TIMEOUT: Duration = Duration::from_secs(8);

impl PluginsManager {
    pub(super) async fn start_engine(
        &self,
        app: &AppHandle,
        package: PreparedPackage,
        ownership: &AtomicBool,
    ) -> AppResult<PluginInfo> {
        // Readers preserve concurrent starts. A package mutation is exclusive
        // through engine initialization, but never through frontend activation.
        // Capture admission before waiting, so a queued start cannot borrow a
        // grant created by the mutation it waited for.
        let id = &package.admission.lease.id;
        let permit = &package.admission.permit;
        let _package = self.admit_package(id, permit).await?;
        let (lease, mut instance) = self.admit_start(id, permit).await?;
        if instance.retired {
            return Err(AppError::NotFound("plugin.notFound".into()));
        }
        let _ = self.runtime_app.set(app.clone());
        let state = app.state::<crate::state::AppState>();
        self.security
            .guard(
                &lease,
                preflight::revalidate_package(&instance.info(), &lease),
            )
            .await?;
        instance.require_runtime()?;
        let prepared = package.engine;
        if instance
            .runtime_lease
            .as_ref()
            .is_some_and(|active| active.generation != lease.generation)
        {
            instance.terminate_host().await?;
            instance.wasm = None;
            instance.node_source = None;
            self.cleanup_retired(
                app,
                vec![security::RuntimeRetirement {
                    id: id.into(),
                    before_generation: lease.generation,
                }],
            );
        }
        let rollback_app = app.clone();
        let activation = self
            .security
            .begin_runtime(
                &lease,
                &package.admission.required,
                instance.manifest.frontend.is_some(),
            )?
            .on_rollback(move |retired| {
                rollback_app
                    .state::<crate::state::AppState>()
                    .plugins
                    .cleanup_retired(&rollback_app, retired);
            });
        ownership.store(activation.owned(), Ordering::Release);
        instance.runtime_lease = Some(lease.clone());
        instance.runtime_id = Some(self.security.lease_stamp(&lease));
        self.security.mark_running(&state.db)?;

        // Another caller may have completed this engine after graph preflight.
        // Register the same dependency binding, then reuse its actual process.
        if instance.host.is_some() {
            self.security.native_ready(&lease)?;
            activation.commit();
            return Ok(instance.info());
        }

        let runtime = match prepared {
            PreparedEngine::Passive => {
                self.security.native_ready(&lease)?;
                activation.commit();
                instance.status = PluginStatus::Running;
                instance.error = None;
                let info = instance.info();
                self.remember(&info);
                let _ = app.emit(STATE_EVENT, &info);
                drop(instance);
                return Ok(info);
            }
            PreparedEngine::Wasm(wasm) => {
                if let Some(wasm) = wasm {
                    instance.wasm = Some(wasm);
                }
                self.security.native_ready(&lease)?;
                activation.commit();
                instance.status = PluginStatus::Running;
                instance.error = None;
                let info = instance.info();
                self.remember(&info);
                let _ = app.emit(STATE_EVENT, &info);
                drop(instance);
                return Ok(info);
            }
            PreparedEngine::ExistingNode => {
                return Err(AppError::validation("pluginSecurity.changed"));
            }
            PreparedEngine::Node(runtime) => runtime,
        };
        let entry = manifest::entry_path(&instance.dir, &instance.manifest.main)?;
        self.remember_source(id, Some((runtime.source().to_owned(), lease.clone())));
        runtime
            .revalidate(&state.db)
            .inspect_err(|_| self.remember_source(id, None))?;
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
                    runtime.path(),
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

        instance.host = Some(host);
        let initialized = self
            .security
            .guard(
                &lease,
                instance.host.as_ref().unwrap().request(
                    "initialize",
                    json!({
                        "apiVersion": instance.manifest.api_version,
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
            instance.terminate_host().await?;
            self.remember_source(id, None);
            instance.status = PluginStatus::Stopped;
            instance.error = None;
            let info = instance.info();
            self.remember(&info);
            let _ = app.emit(STATE_EVENT, &info);
            drop(instance);
            return Err(error);
        }

        match initialized {
            Ok(_) => {
                self.security.native_ready(&lease)?;
                activation.commit();
                instance.node_source = Some(runtime.source().to_owned());
                instance.status = PluginStatus::Running;
                instance.error = None;
            }
            Err(error) => {
                let detail = error.to_string();
                let reason = detail.split(':').next().unwrap_or("plugin.error");
                tracing::warn!(plugin_id = %id, reason, "plugin initialization failed");
                instance.terminate_host().await?;
                self.remember_source(id, None);
                instance.status = PluginStatus::Failed;
                instance.error = Some(error.to_string());
            }
        }

        let info = instance.info();
        self.remember(&info);
        let _ = app.emit(STATE_EVENT, &info);
        drop(instance);
        Ok(info)
    }
}
