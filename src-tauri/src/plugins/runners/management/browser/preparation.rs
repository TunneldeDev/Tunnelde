//! Register cancellation before reading OS credentials; never insert a late result.
use super::{
    connection,
    contracts::OpenRequest,
    contracts::Plan,
    destination,
    registry::{self, Connection, Pending, Registry},
};
use crate::{
    error::{AppError, AppResult},
    ssh::session::review::{Review, Target},
    state::AppState,
};
use std::{future::Future, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};

struct Preparation<'a> {
    registry: &'a Registry,
    id: String,
    pending: Arc<Pending>,
    delivered: bool,
}

impl<'a> Preparation<'a> {
    fn begin(registry: &'a Registry, id: String, pending: Arc<Pending>) -> AppResult<Self> {
        pending
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .busy = true;
        registry.insert(id.clone(), pending.clone())?;
        Ok(Self {
            registry,
            id,
            pending,
            delivered: false,
        })
    }

    async fn capture<T>(
        mut self,
        mut validate: impl FnMut() -> AppResult<()>,
        capture: impl Future<Output = AppResult<(T, Option<Review>)>>,
    ) -> AppResult<T> {
        let result = registry::guard(&self.pending, async {
            validate()?;
            let (plan, review) = capture.await?;
            let mut connection = self
                .pending
                .connection
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // Cancellation shares this mutex. The recovery token and original
            // displayed host are not replaced with a more recent selection.
            validate()?;
            connection.review = review;
            connection.busy = false;
            Ok(plan)
        })
        .await?;
        self.delivered = true;
        Ok(result)
    }
}

impl Drop for Preparation<'_> {
    fn drop(&mut self) {
        if !self.delivered {
            // Also handles a dropped IPC future. A replacement with the same
            // request id must survive an old worker or guard finishing late.
            self.registry.remove_matching(&self.id, &self.pending);
        }
    }
}

pub(super) async fn prepare(app: &AppHandle, request: OpenRequest) -> AppResult<Plan> {
    uuid::Uuid::parse_str(&request.id)
        .map_err(|_| AppError::validation("plugin.api.invalid:id"))?;
    let context = super::super::query::context(app, &request.plugin_id)?;
    let record = super::super::query::selected(&context, &request.token)?;
    destination::identity(&record)?;
    super::super::super::validate_directory(
        &record.deployment.directory,
        &record.deployment.platform,
    )?;
    let state = app.state::<AppState>();
    let mut sessions = state.ssh.list();
    sessions.sort_by(|a, b| a.id.cmp(&b.id));
    let session = sessions
        .into_iter()
        .find(|session| destination::reusable(app, &record, session));
    let host = if session.is_none() {
        Some(destination::host(app, &record)?)
    } else {
        None
    };
    let lease = state
        .runners
        .admit(&request.plugin_id, &format!("browser:{}", request.token))?;
    let (cancelled, mut signal) = tokio::sync::watch::channel(false);
    let pending = Arc::new(Pending {
        plugin_id: request.plugin_id,
        token: request.token,
        record,
        cancelled,
        connection: std::sync::Mutex::new(Connection {
            session,
            ..Default::default()
        }),
        _lease: lease,
    });
    let preparation =
        Preparation::begin(&state.runners.browsers, request.id.clone(), pending.clone())?;
    // Expiry starts at admission, including time spent waiting for OS access.
    let expiry_app = app.clone();
    let expiring = Arc::downgrade(&pending);
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(900)) => {
                if let Some(pending) = expiring.upgrade() {
                    if let Some(expired) = expiry_app.state::<AppState>().runners.browsers.remove_matching(&request.id, &pending) {
                        connection::dispose(&expiry_app, &expired);
                    }
                }
            }
            _ = signal.changed() => {}
        }
    });
    let worker_app = app.clone();
    let worker_pending = pending.clone();
    preparation
        .capture(|| destination::current(app, &pending), async move {
            if host.is_none() {
                return Ok((
                    Plan {
                        host,
                        jump_hosts: vec![],
                    },
                    None,
                ));
            }
            crate::services::credentials::inspect(move || {
                // Recheck the exact recovery record at actual worker admission,
                // before a proxy credential prompt can be started.
                destination::current(&worker_app, &worker_pending)?;
                let target = Target::from_displayed(&worker_app, host.as_ref().expect("host"))?;
                destination::current(&worker_app, &worker_pending)?;
                let review = target.review();
                Ok((
                    Plan {
                        host,
                        jump_hosts: target.jump_hosts(),
                    },
                    Some(review),
                ))
            })
            .await
        })
        .await
}

#[cfg(test)]
mod tests;
