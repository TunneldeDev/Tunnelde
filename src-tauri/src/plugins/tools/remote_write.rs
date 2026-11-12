//! Retain the approved target/root aliases and bytes through the native worker.
use super::*;
use russh_sftp::client::SftpSession;

pub(in crate::plugins) struct RemoteWriteApproval {
    requested: String,
    target: String,
    root_path: String,
    root_target: String,
    hash: String,
}

impl RemoteWriteApproval {
    pub(super) async fn prepare(
        context: &HostContext,
        input: &Value,
        normalized: &Value,
        scope: &Scope,
        hash: String,
    ) -> AppResult<Self> {
        let session_id: String = field(normalized, "sessionId")?;
        let requested: String = field(input, "path")?;
        let target: String = field(normalized, "path")?;
        let sftp = crate::ssh::files::session(&context.app, &session_id).await?;
        let result = async {
            if resolve(&sftp, &requested).await? != target {
                return Err(AppError::validation("plugin.tools.targetChanged"));
            }
            for root in scope
                .remote_roots
                .iter()
                .filter(|r| r.session_id == session_id)
            {
                let resolved = resolve(&sftp, &root.path).await?;
                if remote_within(&target, &resolved) {
                    return Ok(Self {
                        requested,
                        target,
                        root_path: root.path.clone(),
                        root_target: resolved,
                        hash,
                    });
                }
            }
            Err(AppError::validation("plugin.tools.outsideScope"))
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub(in crate::plugins) async fn check(
        &self,
        sftp: &SftpSession,
        target: &str,
        original: &str,
    ) -> AppResult<()> {
        let requested = resolve(sftp, &self.requested).await?;
        let canonical = resolve(sftp, &self.target).await?;
        let root = resolve(sftp, &self.root_path).await?;
        self.check_resolved(target, &requested, &canonical, &root, original)
    }

    fn check_resolved(
        &self,
        target: &str,
        requested: &str,
        canonical: &str,
        root: &str,
        original: &str,
    ) -> AppResult<()> {
        if target != self.target
            || requested != self.target
            || canonical != self.target
            || root != self.root_target
            || !remote_within(target, root)
        {
            return Err(AppError::validation("plugin.tools.targetChanged"));
        }
        if format!("{:x}", Sha256::digest(original.as_bytes())) != self.hash {
            return Err(AppError::validation("plugin.tools.fileChanged"));
        }
        Ok(())
    }
}

async fn resolve(sftp: &SftpSession, path: &str) -> AppResult<String> {
    sftp.canonicalize(path)
        .await
        .map_err(|_| AppError::validation("plugin.tools.targetChanged"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_or_reused_request_cannot_admit_remote_publication() {
        let plugin = format!("remote-write-{}", uuid::Uuid::new_v4());
        let client = "client";
        let key = format!("{plugin}:1:request");
        let register = |registration| {
            let (sender, _) = oneshot::channel();
            register_pending(
                &key,
                Pending {
                    registration,
                    plugin: plugin.clone(),
                    generation: 1,
                    client: client.into(),
                    cancel: sender,
                },
            )
            .unwrap();
        };
        let first = uuid::Uuid::new_v4();
        register(first);
        with_request_authorized(&plugin, 1, Some(client), Some(first), || Ok(())).unwrap();
        assert_eq!(cancel_pending(&plugin, 1, "request", "tools.cancel").0, 1);
        assert_eq!(
            with_request_authorized(
                &plugin,
                1,
                Some(client),
                Some(first),
                || -> AppResult<()> { panic!("cancelled request published") }
            )
            .unwrap_err()
            .to_string(),
            "plugin.tools.cancelled"
        );
        let second = uuid::Uuid::new_v4();
        register(second);
        assert!(with_request_authorized(&plugin, 1, Some(client), Some(first), || Ok(())).is_err());
        with_request_authorized(&plugin, 1, Some(client), Some(second), || Ok(())).unwrap();
        cancel_pending(&plugin, 1, client, "tools.revokeClient");
        assert_eq!(
            with_request_authorized(
                &plugin,
                1,
                Some(client),
                Some(second),
                || -> AppResult<()> { panic!("revoked client published") }
            )
            .unwrap_err()
            .to_string(),
            "plugin.tools.clientRevoked"
        );
        resources().lock().unwrap().retain(|r| r.plugin != plugin);
    }

    #[test]
    fn approval_retains_each_alias_boundary_and_the_exact_approved_bytes() {
        let approval = RemoteWriteApproval {
            requested: "/alias/note.txt".into(),
            target: "/work/note.txt".into(),
            root_path: "/alias".into(),
            root_target: "/work".into(),
            hash: format!("{:x}", Sha256::digest(b"original")),
        };
        assert!(approval
            .check_resolved(
                "/work/note.txt",
                "/work/note.txt",
                "/work/note.txt",
                "/work",
                "original"
            )
            .is_ok());
        for (target, alias, canonical, root, bytes, error) in [
            (
                "/work/other.txt",
                "/work/note.txt",
                "/work/note.txt",
                "/work",
                "original",
                "plugin.tools.targetChanged",
            ),
            (
                "/work/note.txt",
                "/elsewhere/note.txt",
                "/work/note.txt",
                "/work",
                "original",
                "plugin.tools.targetChanged",
            ),
            (
                "/work/note.txt",
                "/work/note.txt",
                "/elsewhere/note.txt",
                "/work",
                "original",
                "plugin.tools.targetChanged",
            ),
            (
                "/work/note.txt",
                "/work/note.txt",
                "/work/note.txt",
                "/",
                "original",
                "plugin.tools.targetChanged",
            ),
            (
                "/work/note.txt",
                "/work/note.txt",
                "/work/note.txt",
                "/work",
                "changed",
                "plugin.tools.fileChanged",
            ),
        ] {
            assert_eq!(
                approval
                    .check_resolved(target, alias, canonical, root, bytes)
                    .unwrap_err()
                    .to_string(),
                error
            );
        }
    }
}
