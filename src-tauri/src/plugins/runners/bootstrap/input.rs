//! Sensitive launch input is bounded in memory, never included in diagnostics.
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) const MAX_CONFIGURATION: usize = 200 * 1024;
const MAX_SECRETS: usize = 256 * 1024;
const MAX_ENVELOPE: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::plugins::runners) struct Request {
    pub session_id: String,
    pub directory: String,
    configuration: Value,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

impl Request {
    pub(in crate::plugins::runners) fn parse(params: Value) -> AppResult<Self> {
        let request: Self = serde_json::from_value(params)
            .map_err(|_| AppError::validation("plugin.runners.invalidInitialization"))?;
        if !request.configuration.is_object() {
            return Err(AppError::validation("plugin.runners.invalidInitialization"));
        }
        if serde_json::to_vec(&request.configuration)?.len() > MAX_CONFIGURATION
            || serde_json::to_vec(&request.secrets)?.len() > MAX_SECRETS
        {
            return Err(AppError::validation("plugin.runners.inputTooLarge"));
        }
        Ok(request)
    }

    pub(in crate::plugins::runners) fn envelope(&self) -> AppResult<String> {
        let packet =
            json!({"schemaVersion":1,"configuration":self.configuration,"secrets":self.secrets});
        let text = serde_json::to_string(&packet)?;
        if text.len() > MAX_ENVELOPE {
            return Err(AppError::validation("plugin.runners.inputTooLarge"));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_and_oversized_configuration_without_exposing_values() {
        let valid = json!({"sessionId":"s","directory":"/runner","configuration":{},"secrets":{"key":"private-value"}});
        let parsed = Request::parse(valid.clone()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&parsed.envelope().unwrap()).unwrap()["secrets"]["key"],
            "private-value"
        );
        for (field, value) in [
            ("configuration", json!([])),
            (
                "configuration",
                json!({"private":"x".repeat(MAX_CONFIGURATION)}),
            ),
            ("secrets", json!({"private":true})),
            ("config", json!("private-value")),
        ] {
            let mut bad = valid.clone();
            bad[field] = value;
            let error = Request::parse(bad).err().unwrap().to_string();
            assert!(!error.contains("private-value"));
        }
    }
}
