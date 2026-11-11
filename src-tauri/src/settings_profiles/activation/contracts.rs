//! Native settings UI requests; public profile DTOs remain a separate boundary.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "camelCase", deny_unknown_fields)]
pub enum Apply {
    Saved { id: String, revision: String },
    Import { settings: Value },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub profiles: Vec<super::super::SettingsProfile>,
    pub revision: String,
    pub active_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::Apply;
    use serde_json::json;

    #[test]
    fn native_activation_requests_reject_ambiguous_shapes() {
        for value in [
            json!({"source":"unknown","settings":{}}),
            json!({"source":"saved","id":"work"}),
            json!({"source":"saved","id":"work","revision":null}),
            json!({"source":"saved","id":"work","revision":"x","settings":{}}),
            json!({"source":"import","settings":{},"id":"work"}),
        ] {
            assert!(serde_json::from_value::<Apply>(value).is_err());
        }
        assert!(serde_json::from_value::<Apply>(
            json!({"source":"import","settings":{"theme":"dark"}})
        )
        .is_ok());
    }
}
