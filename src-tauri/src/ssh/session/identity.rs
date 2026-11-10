//! Captured transport identity, independent of later edits to saved host settings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdentity {
    pub host_id: String,
    pub address: String,
    pub server_key: String,
}
