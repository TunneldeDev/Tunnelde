use super::*;
pub(super) async fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    Ok(context
        .app
        .state::<AppState>()
        .mounts
        .owned_resources(&context.id, context.generation)
        .await?
        .into_iter()
        .map(|(id, cleanup)| {
            Entry::new(
                context,
                Kind::Mount,
                if cleanup {
                    State::CleanupRequired
                } else {
                    State::Owned
                },
                &id,
                Target::Mount(id.clone()),
            )
        })
        .collect())
}
pub(super) async fn release(context: &HostContext, id: &str) -> AppResult<Outcome> {
    // The mount registry rechecks this exact UUID/owner/generation under its
    // async lock and checks current policy before touching the filesystem.
    context
        .app
        .state::<AppState>()
        .mounts
        .release_owned_resource(&context.id, context.generation, id, || {
            authorized(context, || Ok(()))
        })
        .await?;
    Ok(Outcome::Released)
}
