use serde::{Deserialize, Serialize};

/// Internal WebView admission, never persisted or exposed through the plugin SDK.
/// It identifies an approved package and grant in this host process; it grants
/// no permissions and is revalidated before and after asynchronous work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartPermit {
    pub(in crate::plugins) fingerprint: String,
    pub(in crate::plugins) stamp: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(in crate::plugins) packages: Vec<PackagePermit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::plugins) struct PackagePermit {
    pub id: String,
    pub fingerprint: String,
    pub stamp: String,
}

impl StartPermit {
    pub(in crate::plugins) fn single(
        security: &crate::plugins::security::PluginSecurity,
        lease: &crate::plugins::security::Lease,
    ) -> Self {
        Self {
            fingerprint: lease.fingerprint.clone(),
            stamp: security.lease_stamp(lease),
            packages: vec![],
        }
    }
}
