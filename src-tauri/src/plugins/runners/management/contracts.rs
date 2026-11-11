use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owners {
    pub ids: Vec<String>,
    pub limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub token: String,
    pub runner_id: String,
    pub host_id: String,
    pub directory: String,
    pub address: Option<String>,
    pub server_key: Option<String>,
    pub stop_pending: bool,
    pub launch_uncertain: bool,
    pub terminal_status: Option<String>,
    pub connection: &'static str,
    pub control_changed: bool,
    pub can_review_destination: bool,
    pub can_handoff: bool,
    pub can_inspect: bool,
    pub can_stop: bool,
    pub can_forget: bool,
    pub deployment_state: Option<&'static str>,
    pub configuration_state: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub plugin_id: String,
    pub entries: Vec<Entry>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Inspect,
    Stop,
    ReviewDestination,
    Handoff,
    Forget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub plugin_id: String,
    pub token: String,
    pub action: Action,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub token: String,
    pub status: String,
    pub error: Option<String>,
    pub checked_at: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub accepted: bool,
    pub observation: Option<Observation>,
}
