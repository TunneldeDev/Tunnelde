//! Builtin-only reviewed starts. The original interaction owns every phase;
//! credentials are request-local, never part of a panel capsule/read model.
use super::*;
use crate::ssh::{
    session::review::{Review, Target},
    SessionInfo, SshConnectRequest,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

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
impl Credentials {
    pub(super) fn valid(&self) -> bool {
        let length = |value: &Option<String>| value.as_ref().map_or(0, String::len);
        let mut total = length(&self.password) + length(&self.passphrase);
        if self.jumps.len() > 8 || total > 128 * 1024 {
            return false;
        }
        for (id, hop) in &self.jumps {
            let bytes = length(&hop.password) + length(&hop.passphrase);
            if id.is_empty()
                || id.len() > 128
                || id.chars().any(char::is_control)
                || bytes > 128 * 1024
            {
                return false;
            }
            total += bytes;
        }
        total <= 512 * 1024
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
                .map(|(id, hop)| {
                    (
                        id,
                        crate::ssh::session::HopCredential {
                            password: hop.password,
                            passphrase: hop.passphrase,
                        },
                    )
                })
                .collect(),
        }
    }
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
        let current = domain::repository::find_entry(&effect.app, &entry.rule.id)?;
        if current.revision != entry.revision {
            return Err(AppError::validation("forward.changed"));
        }
        observed.with_current(&effect.app, |_| Ok(()))
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
