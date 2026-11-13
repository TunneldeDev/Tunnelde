//! Main-application prompt review. Each call keeps its route snapshot; retries
//! must match the prior reviewed revision before opening any network transport.
//! These DTOs are private native IPC, not stable automation/plugin contracts.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Review {
    pub host_id: String,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    pub review: Review,
    pub jump_hosts: Vec<Host>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Trusted {
    pub info: HostKeyInfo,
    pub review: Review,
}

/// Opaque captured acquisition; callers cannot replace its hosts or transport.
pub(crate) struct Target(route::Snapshot);

fn changed() -> AppError {
    AppError::Ssh("ssh.connectionChanged".into())
}

pub(crate) fn prepare(app: &AppHandle, displayed: &Host) -> AppResult<Plan> {
    // Snapshot::verify compares the displayed connection fields against native
    // storage, rejecting a stale dialog before it can send any credentials.
    let target = Target::from_displayed(app, displayed)?;
    Ok(Plan {
        review: target.review(),
        jump_hosts: target.0.jump_hosts(),
    })
}

impl Target {
    pub(crate) fn jump_hosts(&self) -> Vec<Host> {
        self.0.jump_hosts()
    }
    pub(crate) fn from_displayed(app: &AppHandle, displayed: &Host) -> AppResult<Self> {
        Ok(Self(route::Snapshot::capture(app, displayed)?))
    }

    pub(crate) fn capture(app: &AppHandle, review: &Review) -> AppResult<Self> {
        if review.revision.len() != 64
            || !review.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(changed());
        }
        let host = crate::services::hosts::resolve(app, &review.host_id)?;
        let target = Self(route::Snapshot::capture(app, &host)?);
        if target.0.revision() != review.revision {
            return Err(changed());
        }
        Ok(target)
    }

    pub(crate) fn review(&self) -> Review {
        Review {
            host_id: self.0.target().id.clone(),
            revision: self.0.revision(),
        }
    }

    pub(crate) fn verify(&self, app: &AppHandle) -> AppResult<()> {
        self.0.verify(app)
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.0.target().id
    }

    pub(crate) fn credential(
        &self,
        app: &AppHandle,
        host_id: &str,
        password: Option<&str>,
    ) -> AppResult<()> {
        if !self.0.contains_host(host_id) {
            return Err(changed());
        }
        if password == Some("") {
            return Err(AppError::validation("ssh.passwordRequired"));
        }
        self.with_current(app, |conn| {
            db::hosts::find_host(conn, host_id)?;
            match password {
                Some(password) => crate::vault::save(host_id, password),
                None => crate::vault::forget(host_id),
            }
        })
    }

    pub(crate) fn with_current<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.0.with_current(app, operation)
    }

    pub(crate) async fn probe(
        &self,
        app: &AppHandle,
        credentials: &HashMap<String, HopCredential>,
    ) -> AppResult<HostKeyInfo> {
        route::probe(app, &self.0, credentials, None).await
    }

    /// Recovery additionally pins the target key recorded by the original runner.
    pub(crate) async fn probe_bound(
        &self,
        app: &AppHandle,
        credentials: &HashMap<String, HopCredential>,
        destination: &SessionIdentity,
    ) -> AppResult<HostKeyInfo> {
        route::probe(app, &self.0, credentials, Some(destination)).await
    }

    pub(crate) async fn trust(
        self,
        app: &AppHandle,
        fingerprint: &str,
        expected_host_id: &str,
        credentials: &HashMap<String, HopCredential>,
    ) -> AppResult<Trusted> {
        let info = self.probe(app, credentials).await?;
        if info.fingerprint != fingerprint || info.host_id != expected_host_id {
            return Err(AppError::Ssh("ssh.hostKeyChanged".into()));
        }
        self.approve(app, info)
    }

    /// The requester may hold its own synchronous authority guard across the
    /// final trust write, after probing without locks.
    pub(crate) fn approve(mut self, app: &AppHandle, info: HostKeyInfo) -> AppResult<Trusted> {
        self.0.approve_reviewed(app, &info)?;
        Ok(self.trusted(info))
    }

    pub(crate) fn approve_checked(
        mut self,
        app: &AppHandle,
        info: HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<Trusted> {
        self.0.approve_reviewed_checked(app, &info, check)?;
        Ok(self.trusted(info))
    }

    fn trusted(&self, info: HostKeyInfo) -> Trusted {
        Trusted {
            info: HostKeyInfo {
                status: HostKeyStatus::Known,
                known_fingerprint: Some(info.fingerprint.clone()),
                ..info
            },
            review: self.review(),
        }
    }

    pub(crate) async fn connect(
        &self,
        app: AppHandle,
        request: SshConnectRequest,
        password_auth: bool,
        published: bool,
    ) -> AppResult<SessionInfo> {
        if request.host_id != self.0.target().id {
            return Err(changed());
        }
        connect_captured(app, request, password_auth, published, None, &self.0).await
    }

    pub(crate) async fn connect_bound(
        &self,
        app: AppHandle,
        request: SshConnectRequest,
        destination: &SessionIdentity,
    ) -> AppResult<SessionInfo> {
        if request.host_id != self.0.target().id {
            return Err(changed());
        }
        connect_captured(app, request, false, false, Some(destination), &self.0).await
    }
}

impl Review {
    pub(crate) fn identity(&self) -> &str {
        &self.revision
    }
}
