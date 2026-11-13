//! Cleanup continues the original task's ownership rather than borrowing an exemption.
use super::*;

pub(in super::super) async fn prepare_cleanup(
    app: &AppHandle,
    row: &durable::DurableTransfer,
    to: &Endpoint,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let Some(original) = state.native_saves.transfer_task_intent(&row.id).await? else {
        if state.db.with(|conn| checkpoint::exists(conn, &row.id))? {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        // Legacy/non-enabled tasks have no private owner. Destination cleanup
        // retains the generic fence and never requires an unrelated source peer.
        return Ok(());
    };
    let from = Endpoint {
        session: if row.remove_source {
            durable::resolve_session(
                app,
                row.from_host_id.as_deref(),
                row.from_session.as_deref(),
                row.from_address.as_deref(),
            )?
        } else {
            None
        },
        path: row.from_path.clone(),
    };
    let destination = native_save::runtime::TaskEndpoint {
        path: to.path.clone(),
        remote: to
            .session
            .as_deref()
            .map(|id| state.ssh.identity(id))
            .transpose()?,
    };
    let endpoints = Endpoints::for_cleanup(original.source, destination);
    let source = if row.remove_source {
        match from.session.as_deref() {
            Some(id) => Some(session(app, id).await?),
            None => None,
        }
    } else {
        None
    };
    let destination = match to.session.as_deref() {
        Some(id) => match session(app, id).await {
            Ok(sftp) => Some(sftp),
            Err(error) => {
                if let Some(sftp) = source {
                    let _ = sftp.close().await;
                }
                return Err(error);
            }
        },
        None => None,
    };
    let result = endpoints
        .prepare(
            app,
            &from,
            to,
            source.as_ref(),
            destination.as_ref(),
            &row.id,
            row.remove_source,
            row.overwrite,
            &AtomicBool::new(false),
        )
        .await;
    if let Some(sftp) = source {
        let _ = sftp.close().await;
    }
    if let Some(sftp) = destination {
        let _ = sftp.close().await;
    }
    result
}
