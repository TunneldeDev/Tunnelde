use super::*;
pub(super) fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    Ok(context
        .app
        .state::<AppState>()
        .transfers
        .owned_resources(&context.id, context.generation)?
        .into_iter()
        .map(|(id, instance, cancelled)| {
            Entry::new(
                context,
                Kind::Transfer,
                if cancelled {
                    State::ReleaseRequested
                } else {
                    State::Owned
                },
                &instance,
                Target::Transfer {
                    id,
                    instance: instance.clone(),
                },
            )
        })
        .collect())
}
pub(super) fn release(context: &HostContext, id: &str, instance: &str) -> AppResult<Outcome> {
    authorized(context, || {
        context
            .app
            .state::<AppState>()
            .transfers
            .release_owned_resource(id, &context.id, context.generation, instance)
            .then_some(Outcome::CancellationRequested)
            .ok_or_else(unavailable)
    })
}
