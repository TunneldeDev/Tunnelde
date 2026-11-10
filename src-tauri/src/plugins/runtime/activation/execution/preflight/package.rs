use crate::{
    error::{AppError, AppResult},
    plugins::{manifest, security, PluginInfo},
};

/// Scan/install may parse a manifest just before another writer replaces it.
/// Compare the current manifest with the in-memory parse as well as checking
/// the bytes against the original approval.
pub(in crate::plugins::runtime::activation::execution) async fn check(
    instance: &PluginInfo,
    lease: &security::Lease,
) -> AppResult<()> {
    if instance.id != lease.id {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    let directory = std::path::PathBuf::from(&instance.path);
    let expected = serde_json::to_value(&instance.package_manifest)?;
    let digest = super::blocking::run(move || {
        let current = manifest::load(&directory)?;
        if serde_json::to_value(current)? != expected {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        security::fingerprint(&directory)
    })
    .await?;
    if digest != lease.fingerprint
        || instance.fingerprint != lease.fingerprint
        || instance.permissions != lease.permissions
    {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    Ok(())
}
