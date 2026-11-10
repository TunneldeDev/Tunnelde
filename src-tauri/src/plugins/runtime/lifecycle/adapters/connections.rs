use super::*;
pub(super) fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    let state = context.app.state::<AppState>();
    Ok(state
        .plugins
        .sessions
        .owned(&context.id, context.generation)
        .into_iter()
        .filter(|(_, id)| state.ssh.is_active(id))
        .map(|(receipt, session)| {
            Entry::new(
                context,
                Kind::Connection,
                State::Owned,
                receipt.identity(),
                Target::Connection {
                    session,
                    receipt: receipt.clone(),
                },
            )
        })
        .collect())
}
pub(super) async fn release(
    context: &HostContext,
    session: &str,
    receipt: &Ownership,
) -> AppResult<Outcome> {
    let state = context.app.state::<AppState>();
    let disposal = authorized(context, || {
        crate::plugins::tools::with_client_authorized(
            &context.id,
            context.generation,
            receipt.scope.as_ref().map(|s| s.client.as_str()),
            || {
                state
                    .plugins
                    .sessions
                    .handoff(&context.id, context.generation, receipt)
                    .ok_or_else(unavailable)?;
                // Ownership removal is serialized with handoff, client retirement and
                // policy revocation. Network cleanup is awaited outside those gates.
                Ok(crate::ssh::session::begin_disconnect(&context.app, session))
            },
        )
    })?;
    if let Some(disposal) = disposal {
        disposal.finish().await?;
    }
    Ok(Outcome::Released)
}
