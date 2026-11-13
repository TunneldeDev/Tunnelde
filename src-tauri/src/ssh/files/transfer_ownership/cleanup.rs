//! Cleanup continues the original task's ownership rather than borrowing an exemption.
use super::*;

pub(in super::super) async fn prepare_cleanup(
    app: &AppHandle,
    row: &durable::DurableTransfer,
    to: &Endpoint,
) -> AppResult<()> {
    let from = Endpoint {
        session: durable::resolve_session(
            app,
            row.from_host_id.as_deref(),
            row.from_session.as_deref(),
            row.from_address.as_deref(),
        )?,
        path: row.from_path.clone(),
    };
    let endpoints = Endpoints::capture(app, &from, to)?;
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
