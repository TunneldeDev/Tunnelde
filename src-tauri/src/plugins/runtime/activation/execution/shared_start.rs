use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{cleanup::StopMode, coordination::Key};
use crate::{
    error::AppResult,
    plugins::{security::RuntimeRetirement, PluginInfo, PluginStatus, PluginsManager, StartPermit},
    state::AppState,
};

const FRONTEND_EVENT: &str = "plugin://activate-frontend";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendActivation<'a> {
    id: &'a str,
    runtime_id: &'a str,
}

impl PluginsManager {
    pub async fn start(
        &self,
        app: &AppHandle,
        id: &str,
        permit: &StartPermit,
    ) -> AppResult<PluginInfo> {
        // Capture before joining or waiting. No caller can borrow a newer grant.
        let lease = self.admitted_start(id, permit)?;
        let ownership = Arc::new(AtomicBool::new(false));
        let key = Key {
            id: id.to_owned(),
            stamp: self.security.lease_stamp(&lease),
            fingerprint: lease.fingerprint.clone(),
        };
        let (worker_app, cleanup_app) = (app.clone(), app.clone());
        let (worker_id, worker_permit, worker_lease) =
            (id.to_owned(), permit.clone(), lease.clone());
        let cleanup_lease = lease.clone();
        let worker_ownership = ownership.clone();
        let ticket = self.starts.join(
            key,
            move || async move {
                let plugins = &worker_app.state::<AppState>().plugins;
                // Engine initialization already guards its admission and every
                // asynchronous stage. A failed engine retires its own pending
                // lease, so an outer lease guard would hide the real failure.
                let info = plugins
                    .start_engine(&worker_app, &worker_id, &worker_permit, &worker_ownership)
                    .await?;
                if info.status != PluginStatus::Running {
                    return Ok(info);
                }
                plugins
                    .security
                    .guard(&worker_lease, async {
                        if info.frontend.is_some() && !plugins.security.is_ready(&worker_lease)? {
                            worker_app.emit(
                                FRONTEND_EVENT,
                                FrontendActivation {
                                    id: &worker_id,
                                    runtime_id: info.runtime_id.as_deref().unwrap_or_default(),
                                },
                            )?;
                            plugins
                                .security
                                .wait_ready(
                                    &worker_lease,
                                    tokio::time::Instant::now() + Duration::from_secs(15),
                                )
                                .await?;
                        }
                        plugins
                            .security
                            .guard_ready(&worker_lease, async { Ok(info) })
                            .await
                    })
                    .await
            },
            move |success| async move {
                if !success && ownership.load(Ordering::Acquire) {
                    let plugins = &cleanup_app.state::<AppState>().plugins;
                    let retired = plugins.security.retire_lease(&cleanup_lease);
                    plugins.cleanup_retired(&cleanup_app, retired);
                    // A pending engine guard may already have retired the lease.
                    // Its original boundary still allows awaiting local process exit
                    // while preserving every later replacement.
                    let captured = RuntimeRetirement {
                        id: cleanup_lease.id,
                        before_generation: cleanup_lease.generation.saturating_add(1),
                    };
                    plugins
                        .stop_captured(&cleanup_app, &captured, StopMode::Retired)
                        .await?;
                }
                Ok(())
            },
        )?;
        // Wait for settlement, including failure-driven retirement. Guarding
        // this wait by the retired lease would discard the original cause and
        // return before the worker has confirmed local process termination.
        let info = ticket.wait().await?;
        if info.status == PluginStatus::Running {
            self.security.guard_ready(&lease, async { Ok(info) }).await
        } else {
            Ok(info)
        }
    }
}
