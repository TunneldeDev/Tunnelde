//! Private native compound editor command. Persist fields and bind credentials
//! together, then release DB authority before any OS prompt. Stable Host/API
//! DTOs and ordinary domain services remain unchanged.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CredentialChange {
    Keep,
    Save { password: String },
    Forget,
}
impl CredentialChange {
    fn validate(&self) -> AppResult<()> {
        if let Self::Save { password } = self {
            if password.is_empty() || password.len() > 4096 {
                return Err(crate::error::AppError::validation("ssh.passwordRequired"));
            }
        }
        Ok(())
    }
    fn apply<Before, Check, P: native::Platform>(
        &self,
        service: &native::Service<'_, P>,
        request: &native::Request<'_, Before, Check>,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&rusqlite::Connection) -> AppResult<native::Stamp>,
    {
        match self {
            Self::Keep => Ok(()),
            Self::Save { password } => service.save_after_admission(request, password),
            Self::Forget => service.forget_after_admission(request),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostEdit {
    pub(crate) id: Option<String>,
    pub(crate) input: crate::models::HostInput,
    pub(crate) route: crate::network::ConnectionRoute,
    pub(crate) credential: CredentialChange,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSaved {
    host: crate::models::Host,
    credential_error: Option<crate::error::AppError>,
}

/// The actual editor persistence boundary, also exercised with a controlled OS
/// adapter in service regressions. Cancellation and all companion rows share
/// the owning transaction; an invalid route cannot leave a newly saved host.
fn persist_host(
    conn: &rusqlite::Connection,
    id: Option<&str>,
    draft: &crate::models::HostDraft,
    route: &crate::network::ConnectionRoute,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<(crate::models::Host, authority::HostAuthority)> {
    crate::db::atomic(conn, |conn| {
        admit()?;
        let host = match id {
            Some(id) => crate::db::hosts::update_host(conn, id, draft)?,
            None => crate::db::hosts::create_host(conn, draft)?,
        };
        crate::network::save_route_at(conn, &host.id, route)?;
        let authority = authority::HostAuthority::capture(conn, &host.id)?;
        Ok((host, authority))
    })
}

fn apply_host<P: native::Platform>(
    db: &crate::db::Database,
    platform: &P,
    run: uuid::Uuid,
    authority: &authority::HostAuthority,
    credential: &CredentialChange,
) -> AppResult<()> {
    if matches!(credential, CredentialChange::Keep) {
        return Ok(());
    }
    let service = native::Service::new(db, platform, run)?;
    let request = service.capture(
        bindings::Owner::host(&authority.id)?,
        || Ok(()),
        |conn| authority.check(conn),
    )?;
    service.require_binding(&request, &authority.binding)?;
    credential.apply(&service, &request)
}

#[tauri::command]
pub(crate) async fn host_editor_save(app: AppHandle, edit: HostEdit) -> AppResult<HostSaved> {
    edit.credential.validate()?;
    let draft = edit.input.validate()?;
    let cleanup_app = app.clone();
    let result = checked(move |job| {
        let state = app.state::<AppState>();
        let (host, authority) = state.db.with(|conn| {
            persist_host(conn, edit.id.as_deref(), &draft, &edit.route, || {
                job.commit()
            })
        })?;
        crate::services::hosts::service(&app, &state).published_save(&host, edit.id.is_none());
        // Return committed fields even when Keychain persistence fails. The UI
        // can retry the same saved host instead of creating a duplicate.
        let credential_error = apply_host(
            &state.db,
            &state.vault,
            state.credentials.run,
            &authority,
            &edit.credential,
        )
        .err();
        Ok(HostSaved {
            host,
            credential_error,
        })
    })
    .await;
    schedule_cleanup(&cleanup_app);
    result
}

#[cfg(test)]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxySaved {
    settings: crate::settings::Settings,
    credential_error: Option<crate::error::AppError>,
}

fn apply_proxy<P: native::Platform>(
    db: &crate::db::Database,
    platform: &P,
    run: uuid::Uuid,
    authority: &authority::ProxyAuthority,
    credential: &CredentialChange,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    let service = native::Service::new(db, platform, run)?;
    let request = service.capture(
        bindings::Owner::proxy(&authority.profile.id)?,
        || Ok(()),
        |conn| authority.check(conn),
    )?;
    service.require_binding(&request, &authority.binding)?;
    admit()?;
    credential.apply(&service, &request)
}

#[tauri::command]
pub(crate) async fn proxy_profile_save(
    app: AppHandle,
    profile: crate::network::ProxyProfile,
    credential: CredentialChange,
) -> AppResult<ProxySaved> {
    credential.validate()?;
    // Retain the whole compound command after fields are admitted. A caller
    // disappearing between settings and Keychain must not drop credential work.
    WORKERS
        .asynchronous(move |job| async move {
            let worker_app = app.clone();
            let field_job = job.clone();
            let (settings, authority) = crate::services::settings::write(&app, move |writer| {
                let state = worker_app.state::<AppState>();
                let mut prepared = writer.prepare_update({
                    let mut network = state.settings().network;
                    if let Some(existing) = network.profiles.iter_mut().find(|p| p.id == profile.id)
                    {
                        *existing = profile.clone();
                    } else {
                        network.profiles.push(profile.clone());
                    }
                    serde_json::json!({"network":network})
                })?;
                let mut captured = None;
                prepared.persist_guarded(
                    None,
                    |_| field_job.commit(),
                    |conn| {
                        captured = Some(authority::ProxyAuthority::capture(conn, &profile)?);
                        Ok(())
                    },
                )?;
                let settings = prepared.finish(); // Writer is released before OS preparation.
                let authority = captured.expect("persisted companion captures authority");
                Ok((settings, authority))
            })
            .await?;
            let worker_app = app.clone();
            let credential_error = if matches!(credential, CredentialChange::Keep) {
                None
            } else {
                tauri::async_runtime::spawn_blocking(move || {
                    let state = worker_app.state::<AppState>();
                    // The compound worker was admitted with the settings commit.
                    // apply_proxy still rechecks the original binding after queue waits.
                    apply_proxy(
                        &state.db,
                        &state.vault,
                        state.credentials.run,
                        &authority,
                        &credential,
                        || Ok(()),
                    )
                })
                .await
                .map_err(|_| crate::error::AppError::internal("credentials.workerFailed"))
                .and_then(|result| result)
                .err()
            };
            schedule_cleanup(&app);
            Ok(ProxySaved {
                settings,
                credential_error,
            })
        })
        .await
}
