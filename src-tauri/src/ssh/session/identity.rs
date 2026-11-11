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

use super::*;

/// The reviewed target key is pinned even while probing. An edited saved host
/// cannot redirect this verification to a different address or key.
pub(crate) async fn trust_bound(
    app: &AppHandle,
    host: &Host,
    destination: &SessionIdentity,
    fingerprint: &str,
    expected_host_id: Option<&str>,
    credentials: &HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    destination.verify_host(&crate::services::hosts::resolve(app, &host.id)?)?;
    let info = probe_host_bound(app, host, credentials, Some(destination)).await?;
    if info.fingerprint != fingerprint || expected_host_id != Some(info.host_id.as_str()) {
        return Err(AppError::validation("ssh.hostKeyChanged"));
    }
    destination.verify_host(&crate::services::hosts::resolve(app, &host.id)?)?;
    let approved = if info.host_id == host.id {
        host.clone()
    } else {
        crate::services::hosts::resolve(app, &info.host_id)?
    };
    app.state::<AppState>().db.with(|conn| {
        if !host.id.starts_with(crate::plugins::host_sources::PREFIX) {
            destination.verify_host(&db::hosts::find_host(conn, &host.id)?)?;
        }
        db::known_hosts::upsert(
            conn,
            &approved.host,
            approved.port as i64,
            &info.algorithm,
            &info.fingerprint,
        )
    })?;
    Ok(HostKeyInfo {
        status: HostKeyStatus::Known,
        known_fingerprint: Some(info.fingerprint.clone()),
        ..info
    })
}
