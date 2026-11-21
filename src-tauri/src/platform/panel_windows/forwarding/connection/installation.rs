//! Resource-aware original authority also covers authentication workers, not
//! only the final local auth-mode CAS. No resource/authority is serialized.
use super::*;
struct Reviewed {
    effect: Arc<Effect>,
    id: String,
    revision: String,
    host: String,
}
impl Authority for Reviewed {
    fn with_current(&self, run: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        self.effect.with_current(|| {
            self.effect.app.state::<AppState>().db.with(|conn| {
                domain::repository::require_reviewed_host(
                    conn,
                    &self.id,
                    &self.revision,
                    &self.host,
                )
            })?;
            // Drop the read-only DB guard before the caller's transaction.
            // Final resource CAS is repeated INSIDE key publication's guard.
            run()
        })
    }
}

/// Success returns no key path/bytes. Installation switches authentication,
/// invalidating the old review; a later prompt must prepare a fresh review.
pub(in super::super) async fn install_key(
    effect: Arc<Effect>,
    id: String,
    revision: String,
    review: Review,
    password: Option<String>,
    credentials: JumpCredentials,
) -> AppResult<Value> {
    let target = reviewed_target(&effect, &id, &revision, &review).await?;
    let credentials = credentials.for_target(&target)?;
    let authority = Arc::new(Reviewed {
        effect: effect.clone(),
        id: id.clone(),
        revision: revision.clone(),
        host: review.host_id.clone(),
    });
    WorkLifetime::authorized(authority)
        .scope(async {
            crate::ssh::keys::install_target_checked(
                &effect.app,
                target,
                password,
                credentials,
                move |conn| {
                    domain::repository::require_reviewed_host(conn, &id, &revision, &review.host_id)
                },
            )
            .await?;
            Ok(Value::Null)
        })
        .await
}
