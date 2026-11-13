//! Capture authenticated endpoints before opening transfer channels.
use super::*;
use native_save::runtime::TaskEndpoint;

pub(in super::super) struct Endpoints {
    source: TaskEndpoint,
    destination: TaskEndpoint,
}

impl Endpoints {
    pub(in super::super) fn capture(
        app: &AppHandle,
        from: &Endpoint,
        to: &Endpoint,
    ) -> AppResult<Self> {
        let state = app.state::<AppState>();
        let capture = |endpoint: &Endpoint| -> AppResult<TaskEndpoint> {
            Ok(TaskEndpoint {
                path: endpoint.path.clone(),
                remote: endpoint
                    .session
                    .as_deref()
                    .map(|id| state.ssh.identity(id))
                    .transpose()?,
            })
        };
        Ok(Self {
            source: capture(from)?,
            destination: capture(to)?,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(in super::super) async fn prepare(
        &self,
        app: &AppHandle,
        from: &Endpoint,
        to: &Endpoint,
        source: Option<&SftpSession>,
        destination: Option<&SftpSession>,
        id: &str,
        remove_source: bool,
        overwrite: bool,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let state = app.state::<AppState>();
        let mut row = durable::Journal::get(app, id)?;
        if row.from_path != from.path
            || row.to_path != to.path
            || row.remove_source != remove_source
            || row.overwrite != overwrite
            || !projected_endpoint_matches(
                &self.source,
                row.from_host_id.as_deref(),
                row.from_session.as_deref(),
                row.from_address.as_deref(),
            )
            || !projected_endpoint_matches(
                &self.destination,
                row.to_host_id.as_deref(),
                row.to_session.as_deref(),
                row.to_address.as_deref(),
            )
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let task = TransferTask {
            id: id.into(),
            source: self.source.clone(),
            destination: self.destination.clone(),
            remove_source,
            overwrite,
            plugin_id: row.plugin_id.take(),
        };
        let destination_paths = vec![to.path.clone()];
        let source_paths = vec![from.path.clone()];
        let mut targets = Vec::new();
        if let (Some(identity), Some(sftp)) = (&self.destination.remote, destination) {
            targets.push(MutationTarget {
                destination: identity,
                sftp,
                paths: &destination_paths,
            });
        }
        if remove_source {
            if let (Some(identity), Some(sftp)) = (&self.source.remote, source) {
                targets.push(MutationTarget {
                    destination: identity,
                    sftp,
                    paths: &source_paths,
                });
            }
        }
        let authorize = || {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            authorize_task(app, id)?;
            if let Some(id) = from.session.as_deref() {
                if Some(state.ssh.identity(id)?) != self.source.remote {
                    return Err(AppError::validation("editor.nativeChanged"));
                }
            }
            if let Some(id) = to.session.as_deref() {
                if Some(state.ssh.identity(id)?) != self.destination.remote {
                    return Err(AppError::validation("editor.nativeChanged"));
                }
            }
            Ok(())
        };
        authorize()?;
        if targets.is_empty() {
            return Ok(());
        }
        let ownership = state.transfers.ownership(id)?;
        let admitted = admit(
            &state.native_saves,
            &ownership,
            task,
            &targets,
            state.transfers.observation(id)?,
            (
                state.db.with(|conn| checkpoint::exists(conn, id))?,
                |reference: &TransferReference| {
                    state.db.with(|conn| checkpoint::link(conn, id, reference))
                },
            ),
            authorize,
        )
        .await?;
        if !admitted {
            admission::transfer(app, from, to, source, destination, remove_source).await?;
        }
        Ok(())
    }
}

// Historical rows may omit the address, but never switch a remote endpoint to
// local or attach a different host. The private task additionally binds the
// authenticated server key, which the application projection cannot override.
pub(super) fn projected_endpoint_matches(
    endpoint: &TaskEndpoint,
    host_id: Option<&str>,
    session: Option<&str>,
    address: Option<&str>,
) -> bool {
    match &endpoint.remote {
        Some(identity) => {
            host_id == Some(identity.host_id.as_str())
                && address.is_none_or(|address| address == identity.address)
        }
        None => host_id.is_none() && session.is_none() && address.is_none(),
    }
}
