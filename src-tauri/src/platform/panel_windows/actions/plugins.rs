//! Private plugin-browser commands: no install URLs, hashes, permissions or raw manifests.
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginTarget {
    id: String,
    revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum PluginCommand {
    Refresh {},
    LocalInstall {},
    Settings {},
    OpenDirectory {},
    Open { target: PluginTarget },
    Keep { target: PluginTarget },
    Install { target: PluginTarget },
}
impl PluginCommand {
    pub(super) fn valid(&self) -> bool {
        match self {
            Self::Open { target } | Self::Keep { target } | Self::Install { target } => {
                !target.id.is_empty()
                    && target.id.len() <= 2048
                    && !target.id.chars().any(char::is_control)
                    && uuid::Uuid::parse_str(&target.revision).is_ok()
            }
            _ => true,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn commands_are_closed_and_never_accept_install_payloads() {
        for op in ["refresh", "localInstall", "settings", "openDirectory"] {
            assert!(
                serde_json::from_value::<PluginCommand>(json!({"operation":op}))
                    .unwrap()
                    .valid()
            );
            assert!(serde_json::from_value::<PluginCommand>(
                json!({"operation":op,"permissions":["fs.write"]})
            )
            .is_err())
        }
        for op in ["open", "keep", "install"] {
            let v = json!({"operation":op,"target":{"id":"[\"official\",\"p\"]","revision":uuid::Uuid::new_v4().to_string()}});
            assert!(serde_json::from_value::<PluginCommand>(v.clone())
                .unwrap()
                .valid());
            let mut bad = v.clone();
            bad["url"] = json!("https://untrusted.invalid/plugin.zip");
            assert!(serde_json::from_value::<PluginCommand>(bad).is_err());
            let mut bad = v;
            bad["target"]["revision"] = json!("old");
            assert!(!serde_json::from_value::<PluginCommand>(bad)
                .unwrap()
                .valid())
        }
    }
}
