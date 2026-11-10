use crate::{
    error::{AppError, AppResult},
    plugins::{manifest, security, Instance},
};

/// Scan/install may parse a manifest just before another writer replaces it.
/// Compare the current manifest with the in-memory parse as well as checking
/// the bytes against the original approval.
pub(super) async fn check(instance: &Instance, lease: &security::Lease) -> AppResult<()> {
    if instance.retired || instance.manifest.id != lease.id {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    let directory = instance.dir.clone();
    let expected = serde_json::to_value(&instance.manifest)?;
    let digest = tokio::task::spawn_blocking(move || {
        let current = manifest::load(&directory)?;
        if serde_json::to_value(current)? != expected {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        security::fingerprint(&directory)
    })
    .await
    .map_err(|_| AppError::internal("pluginSecurity.packageInvalid"))??;
    if digest != lease.fingerprint
        || instance.fingerprint != lease.fingerprint
        || instance.manifest.permissions != lease.permissions
    {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    Ok(())
}
