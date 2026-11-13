use crate::{models::Host, ssh::SessionInfo};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub id: String,
    pub plugin_id: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// None means a verified user-owned connection is already available.
    pub host: Option<Host>,
    pub jump_hosts: Vec<Host>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub session: SessionInfo,
    pub directory: String,
    pub acquired: bool,
}
