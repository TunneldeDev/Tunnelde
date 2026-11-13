//! A resolved TCP route for one acquisition. URLs can contain proxy credentials;
//! this type deliberately has no Debug or serialization implementation.
use super::*;

#[derive(PartialEq, Eq)]
pub(crate) struct TcpRoute(String);

impl TcpRoute {
    /// Feed resolved transport inputs into a process-local review. Never return
    /// the URL: it can contain a proxy username and password.
    pub(crate) fn update_review(&self, digest: &mut sha2::Sha256) {
        use sha2::Digest;
        digest.update((self.0.len() as u64).to_le_bytes());
        digest.update(self.0.as_bytes());
    }

    pub(crate) fn capture(app: &AppHandle, host: &str, port: u16, proxy: &str) -> AppResult<Self> {
        Ok(Self(tcp_proxy(app, host, port, proxy)?))
    }

    pub(crate) async fn connect(&self, host: &str, port: u16) -> AppResult<Stream> {
        dial(host, port, &self.0).await
    }
}
