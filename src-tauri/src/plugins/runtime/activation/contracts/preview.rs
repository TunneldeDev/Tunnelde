use serde::{Deserialize, Serialize};

/// Exact installed bytes reviewed before asynchronous approval dialogs.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageReview {
    pub id: String,
    pub fingerprint: String,
}

/// Internal WebView review from the installed catalogue. No approval, execution
/// or network operations occur while obtaining this review.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationPlan {
    pub root: String,
    pub packages: Vec<ActivationPackage>,
}

/// Approval needs identity and publisher provenance, not whole README files,
/// settings schemas or unrelated contribution catalogues for every graph node.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationPackage {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fingerprint: String,
    pub runtime: String,
    pub permissions: Vec<String>,
    pub author: Option<String>,
    pub path: String,
    pub source_url: Option<String>,
    pub frontend: Option<crate::plugins::frontend::FrontendManifest>,
}

impl From<&crate::plugins::PluginInfo> for ActivationPackage {
    fn from(info: &crate::plugins::PluginInfo) -> Self {
        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            version: info.version.clone(),
            fingerprint: info.fingerprint.clone(),
            runtime: info.runtime.clone(),
            permissions: info.permissions.clone(),
            author: info.author.clone(),
            path: info.path.clone(),
            source_url: info.source_url.clone(),
            frontend: info.frontend.clone(),
        }
    }
}
