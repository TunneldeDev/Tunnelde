//! A single read-only proxy snapshot owns the client and update route identity.
//! OS credentials and client construction run on the shared bounded worker.
use super::NetworkSettings;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

struct CachedClient {
    route: [u8; 32],
    fingerprint: u64,
    created: Instant,
    client: reqwest::Client,
}
#[derive(Default)]
pub struct HttpClients(Mutex<HashMap<String, CachedClient>>);

// Intentionally neither Debug nor Serialize: the URL can contain credentials.
pub(crate) struct Prepared {
    client: reqwest::Client,
    proxy: Option<String>,
    fingerprint: u64,
}
impl Prepared {
    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }
    pub(crate) fn proxy(&self) -> Option<&str> {
        self.proxy.as_deref()
    }
    pub(crate) fn fingerprint(&self) -> u64 {
        self.fingerprint
    }
}

impl HttpClients {
    fn prepare(&self, feature: &str, proxy: Option<String>) -> AppResult<Prepared> {
        // The same resolved URL is used for cache identity, backoff and updater
        // configuration; do not read the vault again during this operation.
        let route: [u8; 32] = Sha256::digest(serde_json::to_vec(&proxy)?).into();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        proxy.hash(&mut hasher);
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] {
            std::env::var_os(name).hash(&mut hasher);
        }
        let fingerprint = hasher.finish();
        let cached = {
            let clients = self.0.lock().unwrap_or_else(|error| error.into_inner());
            clients
                .get(feature)
                .filter(|cached| {
                    cached.route == route
                        && (proxy.is_some() || cached.created.elapsed() < Duration::from_secs(30))
                })
                .map(|cached| (cached.client.clone(), cached.fingerprint))
        };
        let (client, fingerprint) = match cached {
            Some(prepared) => prepared,
            None => {
                // System proxy/TLS initialization must not retain a cache lock.
                let client = client_for_proxy(proxy.as_deref())?;
                self.0
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(
                        feature.to_owned(),
                        CachedClient {
                            route,
                            fingerprint,
                            created: Instant::now(),
                            client: client.clone(),
                        },
                    );
                (client, fingerprint)
            }
        };
        Ok(Prepared {
            client,
            proxy,
            fingerprint,
        })
    }
}

async fn acquire<T: Send + 'static>(
    prepare: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    crate::services::credentials::inspect(prepare).await
}

/// Use the caller's captured settings, including during a check whose current
/// selection may subsequently change. Its owner still validates publication.
pub(crate) async fn prepare(
    app: &AppHandle,
    feature: &str,
    network: NetworkSettings,
) -> AppResult<Prepared> {
    let state = app.state::<AppState>();
    let expected = super::proxy::Selected::capture(&network, feature, None)?;
    let expires = tokio::time::Instant::now() + Duration::from_secs(15);
    // Capture persisted authority before waiting for a platform worker. The
    // caller's original settings are never silently refreshed to a new route.
    let authority = loop {
        if let Some(authority) = state.db.try_with(|conn| {
            let current = crate::db::settings::load_checked(conn)?.network;
            if super::proxy::Selected::capture(&current, feature, None)? != expected {
                return Err(AppError::validation("network.configurationChanged"));
            }
            crate::services::credentials::lifecycle::selection_authority(
                conn, &current, feature, None,
            )
        })? {
            break authority;
        }
        if tokio::time::Instant::now() >= expires {
            return Err(AppError::validation("network.timeout"));
        }
        tokio::time::sleep_until(
            expires.min(tokio::time::Instant::now() + Duration::from_millis(5)),
        )
        .await;
    };
    let app = app.clone();
    let feature = feature.to_owned();
    acquire(move || {
        let state = app.state::<AppState>();
        let verify = || {
            state.db.with(|conn| {
                let current = crate::db::settings::load_checked(conn)?.network;
                if crate::services::credentials::lifecycle::selection_authority(
                    conn, &current, &feature, None,
                )? != authority
                {
                    return Err(AppError::validation("network.configurationChanged"));
                }
                Ok(())
            })
        };
        verify()?;
        let proxy = super::proxy_url(
            |profile| crate::services::credentials::read_proxy(&state, profile),
            &network,
            &feature,
            None,
        )?;
        verify()?;
        let prepared = state.http_clients.prepare(&feature, proxy)?;
        verify()?;
        Ok(prepared)
    })
    .await
}

pub(crate) async fn http_client(app: &AppHandle, feature: &str) -> AppResult<reqwest::Client> {
    let network = app.state::<AppState>().settings().network;
    Ok(prepare(app, feature, network).await?.client)
}

/// Shared HTTPS transport for real requests and proxy diagnostics. Explicit
/// routes always disable ambient proxy inheritance; TLS verification stays on.
pub(crate) fn client_for_proxy(url: Option<&str>) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("Tunnelde/", env!("CARGO_PKG_VERSION")));
    // Some Windows proxy routes close the Rustls handshake even when the same
    // verified HTTPS request succeeds through Schannel. Use the native backend
    // consistently for diagnostics and real traffic; never disable verification
    // or change the selected proxy to compensate for a failed handshake.
    #[cfg(windows)]
    {
        builder = builder.tls_backend_native();
    }
    if let Some(url) = url {
        builder = builder.no_proxy();
        if !url.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(url).map_err(|_| AppError::validation("network.invalid"))?,
            );
        }
    }
    builder
        .build()
        .map_err(|_| AppError::validation("network.failed"))
}

#[cfg(test)]
mod tests;
