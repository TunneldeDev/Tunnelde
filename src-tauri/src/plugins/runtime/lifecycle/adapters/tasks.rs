use super::*;
pub(super) fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    Ok(
        crate::plugins::tasks::owned_resources(&context.id, context.generation)
            .into_iter()
            .map(|(id, cancelled)| {
                Entry::new(
                    context,
                    Kind::Task,
                    if cancelled {
                        State::ReleaseRequested
                    } else {
                        State::Owned
                    },
                    &id,
                    Target::Task(id.clone()),
                )
            })
            .collect(),
    )
}
pub(super) fn release(context: &HostContext, id: &str) -> AppResult<Outcome> {
    authorized(context, || {
        crate::plugins::tasks::cancel_owned_resource(&context.id, context.generation, id)
            .then_some(Outcome::CancellationRequested)
            .ok_or_else(unavailable)
    })
}
