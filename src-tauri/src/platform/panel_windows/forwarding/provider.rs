//! Host-scoped native provider continuations. Only metadata is retained here;
//! never credentials, a raw provider bearer scope or a caller-chosen plugin.
use super::super::plugin_views::ForwardingAuthority;
use super::*;

pub(super) struct Provider {
    pub(super) authority: ForwardingAuthority,
    target: Target,
    write: bool,
}
impl Provider {
    pub(super) fn capture(
        ownership: &Ownership,
        caller: (&str, &str),
        lease: &Lease,
        token: &str,
        request: &Request,
    ) -> AppResult<Self> {
        let authority = ownership
            .forwarding_provider_authority(caller, lease, token)
            .map_err(native::invalid)?;
        let target = Target::capture(authority.host(), request)?;
        Ok(Self {
            authority,
            target,
            write: !matches!(
                request,
                Request::CopyAddress { .. }
                    | Request::PrepareStart { .. }
                    | Request::CredentialStatus { .. }
            ),
        })
    }
    /// Caller already holds native ownership. Keep module -> policy -> selection
    /// across the target metadata check AND actual short domain transaction.
    /// The domain callbacks must not reenter native/frontend/security locks.
    pub(super) fn with_current<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        self.authority.with_current(app, self.write, || {
            app.state::<AppState>()
                .db
                .with(|conn| self.target.check(conn, self.authority.host()))?;
            operation()
        })
    }
}

/// Captured original resource identity. Rule/group revisions cannot be replaced
/// by a later read-model update while an OS/network phase is waiting.
enum Target {
    Host,
    Rule { id: String, revision: String },
    Group { id: String, revision: String },
}
impl Target {
    fn capture(host: &str, request: &Request) -> AppResult<Self> {
        let invalid = || AppError::validation("plugin.forwarding.expired");
        let rule = |id: &String, revision: &String| Self::Rule {
            id: id.clone(),
            revision: revision.clone(),
        };
        let reviewed =
            |id: &String, revision: &String, review: &crate::ssh::session::review::Review| {
                if review.host_id != host {
                    Err(invalid())
                } else {
                    Ok(rule(id, revision))
                }
            };
        match request {
            Request::CopyAddress { .. } => Ok(Self::Host),
            Request::Disconnect { host_id, .. } | Request::SaveGroup { host_id, .. }
                if host_id != host =>
            {
                Err(invalid())
            }
            Request::Save { rule: saved, .. } if saved.host_id != host => Err(invalid()),
            Request::Save {
                rule: saved,
                revision,
                ..
            } => Ok(match revision {
                Some(revision) => rule(&saved.id, revision),
                None => Self::Host,
            }),
            Request::PrepareStart { id, revision, .. }
            | Request::Stop { id, revision, .. }
            | Request::Remove { id, revision, .. } => Ok(rule(id, revision)),
            Request::Start {
                id,
                revision,
                review,
                ..
            }
            | Request::Probe {
                id,
                revision,
                review,
                ..
            }
            | Request::Trust {
                id,
                revision,
                review,
                ..
            }
            | Request::Test {
                id,
                revision,
                review,
                ..
            }
            | Request::InstallKey {
                id,
                revision,
                review,
                ..
            }
            | Request::CredentialStatus {
                id,
                revision,
                review,
                ..
            }
            | Request::SaveCredential {
                id,
                revision,
                review,
                ..
            }
            | Request::ForgetCredential {
                id,
                revision,
                review,
                ..
            } => reviewed(id, revision, review),
            Request::RemoveGroup { id, revision } => Ok(Self::Group {
                id: id.clone(),
                revision: revision.clone(),
            }),
            Request::SaveGroup {
                id: Some(id),
                revision: Some(revision),
                ..
            } => Ok(Self::Group {
                id: id.clone(),
                revision: revision.clone(),
            }),
            Request::Disconnect { .. } | Request::SaveGroup { .. } => Ok(Self::Host),
            // Cleanup is dispatched before resolving a still-live provider.
            Request::CancelTest { .. } => Err(invalid()),
        }
    }
    fn check(&self, conn: &rusqlite::Connection, host: &str) -> AppResult<()> {
        crate::db::hosts::find_host(conn, host)?;
        let current = match self {
            Self::Host => true,
            Self::Rule { id, revision } => {
                domain::repository::require_reviewed_host(conn, id, revision, host)?;
                true
            }
            Self::Group { id, revision } => domain::groups::list(conn, Some(host))?
                .iter()
                .any(|group| group.id == *id && group.revision == *revision),
        };
        if !current {
            return Err(AppError::validation("forward.changed"));
        }
        Ok(())
    }
}

pub(crate) async fn request(
    app: AppHandle,
    window: &str,
    document: String,
    lease: Lease,
    token: String,
    request: Request,
) -> AppResult<Value> {
    dispatch(app, window, document, lease, request, Some(token)).await
}

#[cfg(test)]
mod tests;
