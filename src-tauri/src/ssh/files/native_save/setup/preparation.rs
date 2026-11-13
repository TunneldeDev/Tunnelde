//! Read-only capture from the actual authenticated editor destination.
use super::{package::Package, remote::Remote};
use crate::{
    error::{AppError, AppResult},
    ssh::files::native_save::{
        contracts::{
            self,
            authority::{Context, Platform},
        },
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
            let canonical = canonical_path(canonical, platform);
            if !platform.absolute(&canonical) {
                return Err(AppError::validation("editor.nativeChanged"));
            }
            let context = Context::authenticated(&remote.identity, canonical.clone(), platform)
                .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
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
pub(in crate::ssh::files::native_save) fn canonical_path(
    path: String,
    platform: Platform,
) -> String {
    if platform == Platform::Windows
        && path.starts_with('/')
        && path.as_bytes().get(2) == Some(&b':')
    {
        path[1..].into()
    } else {
        path
    }
}
pub(in crate::ssh::files::native_save) fn split(
    path: &str,
    platform: Platform,
) -> AppResult<(String, String)> {
    if !platform.absolute(path) {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    let path = if platform == Platform::Windows {
        path.replace('\\', "/")
    } else {
        path.into()
    };
    let (parent, name) = path
        .rsplit_once('/')
        .ok_or_else(|| AppError::validation("sftp.invalidName"))?;
    if matches!(name, "" | "." | "..") {
        return Err(AppError::validation("sftp.invalidName"));
    }
    let parent = if parent.is_empty() { "/" } else { parent };
    let parent = if platform == Platform::Windows && parent.ends_with(':') {
        format!("{parent}/")
    } else {
        parent.into()
    };
    Ok((parent, name.into()))
}
