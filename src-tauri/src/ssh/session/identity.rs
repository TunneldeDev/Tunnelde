//! Captured transport identity, independent of later edits to saved host settings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdentity {
    pub host_id: String,
    pub address: String,
    pub server_key: String,
}

impl SessionIdentity {
    /// Compare the saved destination before opening any route or sending credentials.
    pub(crate) fn verify_host(&self, host: &crate::models::Host) -> crate::error::AppResult<()> {
        if self.host_id != host.id
            || self.address != format!("{}@{}:{}", host.username, host.host, host.port)
        {
            return Err(crate::error::AppError::validation(
                "plugin.runners.destinationChanged",
            ));
        }
        Ok(())
    }
}
