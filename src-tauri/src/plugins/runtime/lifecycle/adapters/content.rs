use super::*;
pub(super) fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    Ok(context
        .app
        .state::<AppState>()
        .plugins
        .file_content
        .owned(&context.id, context.generation)
        .into_iter()
        .map(|(receipt, entry)| {
            Entry::new(
                context,
                Kind::FileContent,
                State::Owned,
                receipt.identity(),
                Target::FileContent {
                    id: entry.id.clone(),
                    receipt: receipt.clone(),
                },
            )
        })
        .collect())
}
pub(super) fn release(context: &HostContext, receipt: &Ownership) -> AppResult<Outcome> {
    let state = context.app.state::<AppState>();
    authorized(context, || {
        let settling = state
            .plugins
            .file_content
            .release(&context.id, context.generation, receipt)
            .ok_or_else(unavailable)?;
        Ok(if settling {
            Outcome::CancellationRequested
        } else {
            Outcome::Released
        })
    })
}
