//! A resolved TCP route for one acquisition. URLs can contain proxy credentials;
//! this type deliberately has no Debug or serialization implementation.
use super::*;

#[derive(PartialEq, Eq)]
pub(crate) struct TcpRoute(String);

impl TcpRoute {
    pub(crate) fn capture(app: &AppHandle, host: &str, port: u16, proxy: &str) -> AppResult<Self> {
        Ok(Self(tcp_proxy(app, host, port, proxy)?))
    }

    pub(crate) async fn connect(&self, host: &str, port: u16) -> AppResult<Stream> {
        dial(host, port, &self.0).await
    }
}
