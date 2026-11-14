//! Read-only capture from the actual authenticated editor destination.
use super::{
    package::Package,
    paths::{canonical_path, split},
    remote::Remote,
};
use crate::{
    error::{AppError, AppResult},
    ssh::files::native_save::{
        contracts::{self, authority::Context},
        journal::{setup::Plan, Selection},
    },
};
use std::time::{Duration, Instant};

pub(super) struct Prepared {
    pub remote: Remote,
    pub plan: Plan,
    pub parent: String,
    pub container: String,
    pub package: Package,
    scope_stamp: Vec<u8>,
    expires: Instant,
}
impl Prepared {
    pub async fn capture(remote: Remote, editor_path: &str) -> AppResult<Self> {
        let package = remote.platform().await?;
        let platform = package
            .identity()
            .platform()
            .ok_or_else(|| AppError::validation("editor.nativePlatformUnsupported"))?;
        let (parent, _) = split(editor_path, platform)?;
        let sftp = remote.sftp().await?;
        let result = async {
            let canonical = sftp
                .canonicalize(&parent)
                .await
                .map_err(crate::ssh::files::map_sftp)?;
            let scope = remote
                .canonical_scope(&canonical_path(canonical, platform), platform)
                .await?;
            if !platform.absolute(&scope) {
                return Err(AppError::validation("editor.nativeChanged"));
            }
            let context = Context::authenticated(&remote.identity, scope.clone(), platform)
                .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
            let canonical = canonical_path(scope, platform);
            // Private, independent scope installations avoid overwriting an executable
            // referenced by an earlier scope or an unsettled operation.
            let container = join(&canonical, ".tunnelde");
            let parent = join(&container, "native-file-saves");
            let install_directory = join(
                &parent,
                &format!(
                    "helper-{}-{}",
                    package.identity().version,
                    uuid::Uuid::new_v4()
                ),
            );
            let selection = Selection {
                protocol: contracts::PROTOCOL.into(),
                executable: join(&install_directory, &package.filename()),
                // Sibling state remains on the target scope's filesystem.
                directory: join(&parent, &format!("state-{}", uuid::Uuid::new_v4())),
            };
            let plan = Plan {
                destination: remote.identity.clone(),
                context,
                install_directory,
                selection,
                package: package.identity(),
            };
            if !plan.valid() {
                return Err(AppError::validation("editor.nativeChanged"));
            }
            // Parent creation is part of installation. Check pre-existing containers
            // read-only; never chmod or take ownership of somebody else's directory.
            remote.inspect_parent(&sftp, &container, platform).await?;
            remote.inspect_parent(&sftp, &parent, platform).await?;
            remote.verify()?;
            Ok((plan, parent, container))
        }
        .await;
        let _ = sftp.close().await;
        let (plan, parent, container) = result?;
        let scope_stamp = remote.scope_stamp(&plan.context.scope, package).await?;
        Ok(Self {
            remote,
            plan,
            parent,
            container,
            package,
            scope_stamp,
            // Consent and the bounded download/upload each have their own deadline.
            // A valid slow download must not expire authority before the first write;
            // the actual scope identity is rechecked at every mutation boundary.
            expires: Instant::now() + Duration::from_secs(360),
        })
    }
    pub fn verify(&self) -> AppResult<()> {
        if Instant::now() >= self.expires || !self.plan.valid() {
            return Err(AppError::validation("editor.nativeSetupExpired"));
        }
        self.remote.verify()
    }
    pub async fn verify_scope(&self) -> AppResult<()> {
        self.verify()?;
        if self
            .remote
            .scope_stamp(&self.plan.context.scope, self.package)
            .await?
            != self.scope_stamp
        {
            return Err(AppError::validation("editor.nativeAuthorityChanged"));
        }
        self.verify()
    }
}
pub(super) fn join(parent: &str, child: &str) -> String {
    format!("{}/{child}", parent.trim_end_matches(['/', '\\']))
}
