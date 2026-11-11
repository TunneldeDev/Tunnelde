use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    pub schema_version: u32,
    pub helper: String,
    pub helper_version: String,
    pub runner_protocols: Vec<u32>,
    pub features: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reason {
    Transport,
    Timeout,
    OutputTooLarge,
    MissingExitStatus,
    NonzeroExit,
    InvalidResponse,
    UnsupportedSchema,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Result {
    Available {
        envelope: Envelope,
    },
    Unavailable {
        reason: Reason,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<u32>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub token: String,
    pub checked_at: i64,
    pub result: Result,
}
