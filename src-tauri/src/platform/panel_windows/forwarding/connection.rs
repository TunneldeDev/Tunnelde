//! Builtin-only reviewed connections. The original interaction owns every phase;
//! credentials are request-local, never part of a panel capsule/read model.
use super::*;
use crate::ssh::{
    session::review::{Review, Target},
    SessionInfo, SshConnectRequest,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

#[derive(Default, Deserialize)]
#[serde(transparent)]
pub(crate) struct JumpCredentials(HashMap<String, Hop>);
impl JumpCredentials {
    pub(super) fn valid(&self) -> bool {
        valid_jumps(&self.0, 0)
    }
    fn for_target(
        self,
        target: &Target,
    ) -> AppResult<HashMap<String, crate::ssh::session::HopCredential>> {
        let jumps = target.jump_hosts();
        if self
            .0
            .keys()
            .any(|id| !jumps.iter().any(|host| &host.id == id))
        {
            return Err(AppError::validation("ssh.connectionChanged"));
        }
        Ok(self
            .0
            .into_iter()
            .map(|(id, hop)| (id, hop.into()))
            .collect())
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credentials {
    password: Option<String>,
    passphrase: Option<String>,
    #[serde(default)]
    jumps: HashMap<String, Hop>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hop {
    password: Option<String>,
    passphrase: Option<String>,
}
impl From<Hop> for crate::ssh::session::HopCredential {
    fn from(hop: Hop) -> Self {
        Self {
            password: hop.password,
            passphrase: hop.passphrase,
        }
    }
}
fn valid_jumps(jumps: &HashMap<String, Hop>, mut total: usize) -> bool {
    if jumps.len() > 8 || total > 128 * 1024 {
        return false;
    }
    for (id, hop) in jumps {
        let bytes = hop.password.as_ref().map_or(0, String::len)
            + hop.passphrase.as_ref().map_or(0, String::len);
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) || bytes > 128 * 1024
        {
            return false;
        }
        total += bytes;
    }
    total <= 512 * 1024
}
impl Credentials {
    pub(super) fn valid(&self) -> bool {
        let length = |value: &Option<String>| value.as_ref().map_or(0, String::len);
        valid_jumps(
            &self.jumps,
            length(&self.password) + length(&self.passphrase),
        )
    }
    fn request(self, host: String) -> SshConnectRequest {
        SshConnectRequest {
            host_id: host,
            background: true,
            purpose: Some("forwarding".into()),
            password: self.password,
            passphrase: self.passphrase,
            cols: 80,
            rows: 24,
            jump_credentials: self
                .jumps
                .into_iter()
                .map(|(id, hop)| (id, hop.into()))
                .collect(),
        }
    }
}

/// A captured target is never a plugin grant; original native authority and
/// the displayed rule are checked around slow route/keychain capture.
async fn reviewed_target(
    effect: &Arc<Effect>,
    id: &str,
    revision: &str,
    review: &Review,
) -> AppResult<Target> {
    let handle = effect.clone();
    let rule = id.to_owned();
    let expected = revision.to_owned();
    let reviewed = review.clone();
    crate::services::credentials::inspect(move || {
        handle.with_current(|| {
            handle.app.state::<AppState>().db.with(|conn| {
                domain::repository::require_reviewed_host(conn, &rule, &expected, &reviewed.host_id)
            })
        })?;
        // Snapshot capture can read an OS proxy credential. Do that outside
        // ownership, then reject any rule edit before admitting network I/O.
        let target = Target::capture(&handle.app, &reviewed)?;
        handle.with_current(|| {
            handle.app.state::<AppState>().db.with(|conn| {
                domain::repository::require_reviewed_host(conn, &rule, &expected, &reviewed.host_id)
            })
        })?;
        Ok(target)
    })
    .await
}

/// Rule and route are checked on both sides of slow network/OS work. Trust
/// publication additionally rechecks the rule within the SAME database guard
/// that writes the observed endpoint and advances its native review.
pub(super) async fn probe(
    effect: Arc<Effect>,
    id: String,
    revision: String,
    review: Review,
    credentials: JumpCredentials,
    approval: Option<(String, String)>,
) -> AppResult<Value> {
    let target = reviewed_target(&effect, &id, &revision, &review).await?;
    let credentials = credentials.for_target(&target)?;
    if approval.as_ref().is_some_and(|(_, host)| {
        host != target.host_id() && !target.jump_hosts().iter().any(|jump| &jump.id == host)
    }) {
        return Err(AppError::validation("ssh.hostKeyChanged"));
    }
    let info = target.probe(&effect.app, &credentials).await?;
    if let Some((fingerprint, expected_host_id)) = &approval {
        if &info.fingerprint != fingerprint || &info.host_id != expected_host_id {
            return Err(AppError::validation("ssh.hostKeyChanged"));
        }
    }
    // Proxy/keychain observation must not run inside ownership or DB guards.
    let observed = target.observe_background(&effect.app).await?;
    crate::services::credentials::checked(move |job| {
        effect.with_current(|| {
            let check = |conn: &rusqlite::Connection| {
                domain::repository::require_reviewed_host(conn, &id, &revision, &review.host_id)?;
                job.commit()
            };
            match approval {
                Some(_) => Ok(json!(observed.approve_checked(&effect.app, info, check)?)),
                None => observed.with_current(&effect.app, |conn| {
                    check(conn)?;
                    Ok(json!(info))
                }),
            }
        })
    })
    .await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptHost {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    source: bool,
}
impl From<crate::models::Host> for PromptHost {
    fn from(host: crate::models::Host) -> Self {
        Self {
            source: host.id.starts_with(crate::plugins::host_sources::PREFIX),
            id: host.id,
            name: host.name,
            host: host.host,
            port: host.port,
            username: host.username,
            auth_method: host.auth_method,
        }
    }
}

pub(super) async fn prepare(effect: Arc<Effect>, id: String, revision: String) -> AppResult<Value> {
    let handle = effect.clone();
    let (entry, host, target) = crate::services::credentials::inspect(move || {
        let entry = handle.with_current(|| domain::repository::find_entry(&handle.app, &id))?;
        if entry.revision != revision {
            return Err(AppError::validation("forward.changed"));
        }
        let host = crate::services::hosts::resolve(&handle.app, &entry.rule.host_id)?;
        let target = Target::from_displayed(&handle.app, &host)?;
        Ok((entry, host, target))
    })
    .await?;
    let observed = target.observe_background(&effect.app).await?;
    effect.with_current(|| {
        observed.with_current(&effect.app, |conn| {
            domain::repository::require_reviewed_host(
                conn,
                &entry.rule.id,
                &entry.revision,
                &entry.rule.host_id,
            )
        })
    })?;
    Ok(
        json!({"review": target.review(), "host": PromptHost::from(host), "jumpHosts": target.jump_hosts().into_iter().map(PromptHost::from).collect::<Vec<_>>()}),
    )
}

pub(super) async fn start(
    effect: Arc<Effect>,
    id: String,
    revision: String,
    review: Review,
    credentials: Credentials,
) -> AppResult<Value> {
    let handle = effect.clone();
    let target = id.clone();
    let expected = revision.clone();
    let reviewed_host = review.host_id.clone();
    let attempt = tauri::async_runtime::spawn_blocking(move || {
        handle.with_current(|| {
            let entry = domain::repository::find_entry(&handle.app, &target)?;
            if entry.revision != expected || entry.rule.host_id != reviewed_host {
                return Err(AppError::validation("ssh.connectionChanged"));
            }
            domain::automation::Attempt::begin(&handle.app, &target, Some(&expected))
        })
    })
    .await
    .map_err(|_| AppError::internal("forward.invalid"))??;
    let prepared = async {
        let target = Target::capture_background(&effect.app, &review).await?;
        let jumps = target.jump_hosts();
        if credentials.jumps.keys().any(|id| !jumps.iter().any(|host| &host.id == id)) {
            return Err(AppError::validation("ssh.connectionChanged"));
        }
        let pending = tokio::select! { biased;
            _ = attempt.cancelled() => return Err(AppError::validation("forward.startCancelled")),
            pending = domain::prepare_managed(&effect.app, &id, Some(&revision), None, Some(credentials.request(review.host_id.clone())), Some(review)) => pending?,
        };
        let session = pending.session();
        // Proxy/keychain observation must finish OUTSIDE ownership/automation
        // locks. The opaque proof remains paired with this pending listener.
        let observed = pending.observe().await?;
        Ok((session, observed))
    }.await;
    let (session, pending) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let result = Err(error);
            if effect.with_current(|| Ok(())).is_ok() {
                attempt.finish(&result, "");
            } else {
                // Lost consent is cancellation, not a retryable transport failure.
                drop(attempt);
            }
            result?;
            unreachable!()
        }
    };
    let handle = effect.clone();
    let (attempt, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = handle.with_current(|| attempt.commit(|| pending.commit()));
        (attempt, result)
    })
    .await
    .map_err(|_| AppError::internal("forward.invalid"))?;
    if result.is_ok() || effect.with_current(|| Ok(())).is_ok() {
        attempt.finish(&result, &session);
    } else {
        drop(attempt);
    }
    result?;
    crate::ssh::session::announce_connection(&effect.app);
    let info: SessionInfo = effect
        .app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|item| item.id == session)
        .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
    Ok(json!(info))
}

pub(super) enum CredentialAction {
    Status,
    Save(String),
    Forget,
}
/// Credential values stay in direct requests/native memory, never projected
/// into read models/capsules. Write intent is explicit, not a missing password.
pub(super) async fn credential(
    effect: Arc<Effect>,
    id: String,
    revision: String,
    review: Review,
    host_id: String,
    action: CredentialAction,
) -> AppResult<Value> {
    let target = reviewed_target(&effect, &id, &revision, &review).await?;
    if !matches!(action, CredentialAction::Status) {
        let password = match action {
            CredentialAction::Save(password) => Some(password),
            CredentialAction::Forget => None,
            CredentialAction::Status => unreachable!(),
        };
        target
            .credential_checked(&effect.app, &host_id, password.as_deref(), move |conn| {
                domain::repository::require_reviewed_host(conn, &id, &revision, &review.host_id)
            })
            .await?;
        return Ok(Value::Null);
    }
    let saved = target.credential_status(&effect.app, &host_id).await?;
    let observed = target.observe_background(&effect.app).await?;
    crate::services::credentials::inspect(move || {
        effect.with_current(|| {
            observed.with_current(&effect.app, |conn| {
                domain::repository::require_reviewed_host(conn, &id, &revision, &review.host_id)?;
                Ok(json!(saved))
            })
        })
    })
    .await
}
