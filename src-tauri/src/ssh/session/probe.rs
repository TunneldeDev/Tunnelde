//! One target for every sample in a connection-quality measurement. Retrying
//! transport failures cannot recapture edited hosts, trust or proxy settings.
use super::*;

pub(in crate::ssh) struct ProbeTarget(route::Snapshot);

impl ProbeTarget {
    pub(in crate::ssh) fn capture(app: &AppHandle, host_id: &str) -> AppResult<Self> {
        let host = crate::services::hosts::resolve(app, host_id)?;
        Ok(Self(route::Snapshot::capture(app, &host)?))
    }

    pub(in crate::ssh) async fn probe(
        &self,
        app: &AppHandle,
        credentials: &HashMap<String, HopCredential>,
    ) -> AppResult<HostKeyInfo> {
        route::probe(app, &self.0, credentials, None).await
    }
}
