//! A resolved TCP route for one acquisition. URLs can contain proxy credentials;
//! this type deliberately has no Debug or serialization implementation.
use super::*;

#[derive(Clone, PartialEq, Eq)]
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

    pub(crate) fn capture_with(
        load: impl FnOnce(&ProxyProfile) -> AppResult<Option<String>>,
        network: &NetworkSettings,
        host: &str,
        port: u16,
        proxy: &str,
    ) -> AppResult<Self> {
        Ok(Self(tcp_proxy_with(load, network, host, port, proxy)?))
    }

    pub(crate) async fn capture_background(
        app: &AppHandle,
        host: &str,
        port: u16,
        proxy: &str,
    ) -> AppResult<Self> {
        let app = app.clone();
        let host = host.to_owned();
        let proxy = proxy.to_owned();
        prepare(move || Self::capture(&app, &host, port, &proxy)).await
    }

    pub(super) fn proxy(&self) -> &str {
        &self.0
    }

    pub(crate) async fn connect(&self, host: &str, port: u16) -> AppResult<Stream> {
        dial(host, port, &self.0).await
    }
}

// The same bounded OS-credential budget is shared with SSH and HTTP preparation.
async fn prepare(
    capture: impl FnOnce() -> AppResult<TcpRoute> + Send + 'static,
) -> AppResult<TcpRoute> {
    crate::services::credentials::inspect(capture).await
}

pub(super) async fn probe(app: &AppHandle, host: &str, port: u16, proxy: &str) -> AppResult<()> {
    probe_prepared(
        host,
        port,
        TcpRoute::capture_background(app, host, port, proxy),
        Duration::from_secs(15),
    )
    .await
}

async fn probe_prepared(
    host: &str,
    port: u16,
    preparation: impl std::future::Future<Output = AppResult<TcpRoute>>,
    budget: Duration,
) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + budget;
    tokio::time::timeout_at(deadline, async {
        let route = preparation.await?;
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::validation("network.timeout"));
        }
        // No application payload. Dropping this future while preparing a route
        // cannot initiate a connection when the OS worker eventually returns.
        drop(route.connect(host, port).await?);
        Ok(())
    })
    .await
    .map_err(|_| AppError::validation("network.timeout"))?
}

#[cfg(test)]
mod tests;
