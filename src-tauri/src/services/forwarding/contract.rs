//! Wire DTOs and endpoint validation; independent of SSH, storage and application state.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardRule {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub mode: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    #[serde(flatten)]
    pub rule: ForwardRule,
    pub session_id: Option<String>,
    pub active: bool,
}
/// Native editing snapshot. The historical plugin DTO remains unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedRule {
    #[serde(flatten)]
    pub rule: ForwardRule,
    /// Opaque persisted token; changes even when values return to an earlier state.
    pub revision: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedInfo {
    pub runtime_id: Option<String>,
    #[serde(flatten)]
    pub info: ForwardInfo,
    pub revision: String,
}
pub(crate) fn validate(rule: &ForwardRule) -> AppResult<()> {
    let host_valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 253
            && !s
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#[]".contains(c))
    };
    if !["local", "remote"].contains(&rule.mode.as_str())
        || rule.id.len() > 128
        || rule.host_id.is_empty()
        || rule.name.trim().is_empty()
        || rule.name.len() > 120
        || rule.bind_port == 0
        || rule.target_port == 0
        || !host_valid(&rule.bind_host)
        || !host_valid(&rule.target_host)
    {
        return Err(AppError::validation("forward.invalid"));
    }
    Ok(())
}
