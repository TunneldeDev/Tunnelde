use super::*;
pub(super) fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    Ok(context
        .app
        .state::<AppState>()
        .forwards
        .owned_resources(&context.id, context.generation)?
        .into_iter()
        .map(|(rule, runtime)| {
            Entry::new(
                context,
                Kind::Forward,
                State::Owned,
                &runtime,
                Target::Forward {
                    rule,
                    runtime: runtime.clone(),
                },
            )
        })
        .collect())
}
pub(super) async fn release(
    context: &HostContext,
    rule: &str,
    runtime: &str,
) -> AppResult<Outcome> {
    let cleanup = authorized(context, || {
        context
            .app
            .state::<AppState>()
            .forwards
            .take_owned_resource(&context.id, context.generation, rule, runtime)
    })?;
    cleanup.finish().await?;
    Ok(Outcome::Released)
}
