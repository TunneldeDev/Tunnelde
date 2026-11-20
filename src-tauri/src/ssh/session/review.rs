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

/// An OS observation awaiting final pure native admission.
pub(crate) struct Observed(route::Observed);
impl Observed {
    pub(crate) fn with_current<T>(
        &self,
        app: &AppHandle,
        effect: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.0.with_current(app, effect)
    }
    pub(crate) fn approve(
        self,
        app: &AppHandle,
        info: HostKeyInfo,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<Trusted> {
        self.approve_checked(app, info, |_| check())
    }
    pub(crate) fn approve_checked(
        self,
        app: &AppHandle,
        info: HostKeyInfo,
        check: impl FnOnce(&rusqlite::Connection) -> AppResult<()>,
    ) -> AppResult<Trusted> {
        let target = Target(self.0.approve(app, &info, check)?);
        Ok(target.trusted(info))
    }
}

fn changed() -> AppError {
    AppError::Ssh("ssh.connectionChanged".into())
}

pub(crate) async fn prepare(app: AppHandle, displayed: Host) -> AppResult<Plan> {
    crate::services::credentials::inspect(move || {
        // Capture at actual worker admission: the displayed connection fields
        // must still match native storage after any queue wait. Transport
        // inspection may read a proxy password and must not run on the UI thread.
        let target = Target::from_displayed(&app, &displayed)?;
        Ok(Plan {
            review: target.review(),
            jump_hosts: target.0.jump_hosts(),
        })
    })
    .await
}

impl Target {
    pub(crate) async fn observe_background(&self, app: &AppHandle) -> AppResult<Observed> {
        Ok(Observed(self.0.observe_background(app).await?))
    }

    pub(crate) async fn capture_background(app: &AppHandle, review: &Review) -> AppResult<Self> {
        let app = app.clone();
        let review = review.clone();
        crate::services::credentials::inspect(move || Self::capture(&app, &review)).await
    }

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

    pub(crate) async fn verify_background(&self, app: &AppHandle) -> AppResult<()> {
        self.0.verify_background(app).await
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.0.target().id
    }

    pub(crate) async fn credential(
        &self,
        app: &AppHandle,
        host_id: &str,
        password: Option<&str>,
    ) -> AppResult<()> {
        self.credential_checked(app, host_id, password, |_| Ok(()))
            .await
    }

    pub(crate) async fn credential_status(
        &self,
        app: &AppHandle,
        host_id: &str,
    ) -> AppResult<bool> {
        if !self.0.contains_host(host_id) {
            return Err(changed());
        }
        let route = self.0.clone();
        Ok(
            crate::services::credentials::load_reviewed(app.clone(), host_id.into(), move |app| {
                route.verify(app)
            })
            .await?
            .is_some(),
        )
    }

    /// The caller's additional resource CAS is checked in the same DB guard
    /// as binding admission/publication. Original WorkLifetime authority is
    /// captured by the credential request; OS IO never holds either guard.
    pub(crate) async fn credential_checked(
        &self,
        app: &AppHandle,
        host_id: &str,
        password: Option<&str>,
        check: impl Fn(&rusqlite::Connection) -> AppResult<()> + Send + 'static,
    ) -> AppResult<()> {
        if !self.0.contains_host(host_id) {
            return Err(changed());
        }
        if password == Some("") {
            return Err(AppError::validation("ssh.passwordRequired"));
        }
        let observed = std::sync::Arc::new(self.0.observe_background(app).await?);
        let before = observed.clone();
        crate::services::credentials::mutate_reviewed(
            app.clone(),
            host_id.into(),
            password.map(str::to_owned),
            move |app| before.before(app),
            move |conn| {
                check(conn)?;
                observed.credential_stamp(conn)
            },
        )
        .await
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
        let app = app.clone();
        crate::services::credentials::checked(move |job| {
            self.approve_checked(&app, info, || job.commit())
        })
        .await
    }

    /// The requester may hold its own synchronous authority guard across the
    /// final trust write, after probing without locks.
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
