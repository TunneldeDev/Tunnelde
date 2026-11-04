use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::time::Duration;

use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::session::{probe_route, HopCredential, HostKeyInfo, HostKeyStatus, SshManager};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const SAMPLES: usize = 3;
const BUDGET: Duration = Duration::from_secs(25);

#[derive(Default)]
pub(super) struct DiagnosticState {
    running: HashMap<String, (String, AbortHandle)>,
    cancelled: VecDeque<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    Fast,
    Normal,
    Slow,
    Unstable,
    Unreachable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionQuality {
    pub attempts: usize,
    pub successful: usize,
    pub samples_ms: Vec<Option<u64>>,
    pub median_ms: Option<u64>,
    pub spread_ms: Option<u64>,
    pub quality: Quality,
    pub last_error: Option<String>,
}

fn summarize(samples_ms: Vec<Option<u64>>, last_error: Option<String>) -> ConnectionQuality {
    let mut successful: Vec<u64> = samples_ms.iter().flatten().copied().collect();
    successful.sort_unstable();
    let median_ms = match successful.len() {
        0 => None,
        2 => Some(successful[0] + (successful[1] - successful[0]) / 2),
        n => Some(successful[n / 2]),
    };
    let quality = match median_ms {
        None => Quality::Unreachable,
        Some(_) if successful.len() < samples_ms.len() => Quality::Unstable,
        Some(ms) if ms <= 500 => Quality::Fast,
        Some(ms) if ms <= 1500 => Quality::Normal,
        _ => Quality::Slow,
    };
    ConnectionQuality {
        attempts: samples_ms.len(),
        successful: successful.len(),
        spread_ms: if successful.len() > 1 {
            Some(successful[successful.len() - 1] - successful[0])
        } else {
            None
        },
        samples_ms,
        median_ms,
        quality,
        last_error,
    }
}

fn fatal(error: &AppError) -> bool {
    match error {
        AppError::Ssh(message) => [
            "ssh.authFailed",
            "ssh.passwordRequired",
            "ssh.keyLoad",
            "ssh.keyPathRequired",
            "ssh.hostKeyChanged",
            "ssh.hostKeyUntrusted",
            "ssh.usernameRequired",
            "ssh.agentUnsupported",
        ]
        .iter()
        .any(|key| message.starts_with(key)),
        AppError::Io(_) => false,
        AppError::Validation(message) => {
            !["network.timeout", "network.failed"].contains(&message.as_str())
        }
        _ => true,
    }
}

async fn measure<F, Fut>(
    host_id: &str,
    mut probe: F,
    budget: Duration,
) -> AppResult<ConnectionQuality>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<HostKeyInfo>>,
{
    let deadline = tokio::time::Instant::now() + budget;
    let mut samples = Vec::with_capacity(SAMPLES);
    let mut fingerprint = None;
    let mut last_error = None;
    for _ in 0..SAMPLES {
        match tokio::time::timeout_at(deadline, probe()).await {
            Ok(Ok(info)) => {
                if info.status == HostKeyStatus::Changed
                    || fingerprint
                        .as_ref()
                        .is_some_and(|key| key != &info.fingerprint)
                {
                    return Err(AppError::Ssh("ssh.hostKeyChanged".into()));
                }
                if info.status != HostKeyStatus::Known || info.host_id != host_id {
                    return Err(AppError::Ssh("ssh.hostKeyUntrusted".into()));
                }
                fingerprint = Some(info.fingerprint);
                samples.push(info.connection_time_ms);
            }
            Ok(Err(error)) => {
                // Repeating invalid credentials can trigger server lockouts. Key,
                // configuration and authentication failures are never retried.
                if fatal(&error) {
                    return Err(error);
                }
                last_error = Some(error.to_string());
                samples.push(None);
            }
            Err(_) => {
                last_error = Some("ssh.timeout".into());
                samples.push(None);
                break;
            }
        }
    }
    Ok(summarize(samples, last_error))
}

struct Registration<'a> {
    ssh: &'a SshManager,
    id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut tests) = self.ssh.diagnostics.lock() {
            tests.running.remove(self.id);
        }
    }
}

fn register<'a>(
    ssh: &'a SshManager,
    id: &'a str,
    host_id: &str,
) -> AppResult<(Registration<'a>, futures_util::future::AbortRegistration)> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(AppError::validation("ssh.invalidPayload"));
    }
    let mut tests = ssh
        .diagnostics
        .lock()
        .map_err(|_| AppError::internal("ssh.lock"))?;
    if let Some(index) = tests.cancelled.iter().position(|cancelled| cancelled == id) {
        tests.cancelled.remove(index);
        return Err(AppError::Ssh("ssh.testCancelled".into()));
    }
    if tests.running.len() >= 4
        || tests.running.contains_key(id)
        || tests.running.values().any(|(host, _)| host == host_id)
    {
        return Err(AppError::Ssh("ssh.sessionBusy".into()));
    }
    let (abort, registration) = AbortHandle::new_pair();
    tests.running.insert(id.into(), (host_id.into(), abort));
    Ok((Registration { ssh, id }, registration))
}

pub async fn test(
    app: AppHandle,
    id: String,
    host_id: String,
    credentials: HashMap<String, HopCredential>,
) -> AppResult<ConnectionQuality> {
    let state = app.state::<AppState>();
    let (_guard, cancellation) = register(&state.ssh, &id, &host_id)?;
    Abortable::new(
        measure(
            &host_id,
            || probe_route(&app, &host_id, credentials.clone()),
            BUDGET,
        ),
        cancellation,
    )
    .await
    .map_err(|_| AppError::Ssh("ssh.testCancelled".into()))?
}

pub fn cancel(ssh: &SshManager, id: &str) {
    if uuid::Uuid::parse_str(id).is_err() {
        return;
    }
    if let Ok(mut tests) = ssh.diagnostics.lock() {
        if let Some((_, handle)) = tests.running.get(id) {
            handle.abort();
        } else if !tests.cancelled.iter().any(|cancelled| cancelled == id) {
            // IPC cancellation may arrive before the async test's first poll.
            // Retain a bounded tombstone so that closing immediately still cancels.
            if tests.cancelled.len() >= 64 {
                tests.cancelled.pop_front();
            }
            tests.cancelled.push_back(id.into());
        }
    }
}

#[cfg(test)]
mod tests;
