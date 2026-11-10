use serde::{Deserialize, Serialize};

/// Internal WebView admission, never persisted or exposed through the plugin SDK.
/// It identifies an approved package and grant in this host process; it grants
/// no permissions and is revalidated before and after asynchronous work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartPermit {
    pub(in crate::plugins) fingerprint: String,
    pub(in crate::plugins) stamp: String,
}
