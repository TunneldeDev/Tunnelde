//! Native process environment preparation; never hold domain guards during OS reads.
use super::{proxy, NetworkSettings};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

// Resolved proxy credentials stay native and have no Debug or serialization surface.
pub(crate) struct ProcessEnvironment {
    plugin: String,
    selected: proxy::Selected,
    url: Option<String>,
    expires: tokio::time::Instant,
}

fn configured<'a>(network: &'a NetworkSettings, plugin: &str) -> Option<&'a str> {
    network
        .features
        .get(&format!("plugin:{plugin}"))
        .filter(|v| !v.is_empty())
        .map(String::as_str)
}
fn selected(network: &NetworkSettings, plugin: &str) -> AppResult<proxy::Selected> {
    proxy::Selected::capture(network, "processes", configured(network, plugin))
}
fn current(expected: &proxy::Selected, network: &NetworkSettings, plugin: &str) -> AppResult<()> {
    if selected(network, plugin)
        .as_ref()
        .is_ok_and(|actual| actual == expected)
    {
        Ok(())
    } else {
        Err(AppError::validation("network.configurationChanged"))
    }
}
fn verify(app: &AppHandle, expected: &proxy::Selected, plugin: &str) -> AppResult<()> {
    app.state::<AppState>()
        .db
        .with(|conn| verify_saved(conn, expected, plugin))
}

fn verify_saved(
    conn: &rusqlite::Connection,
    expected: &proxy::Selected,
    plugin: &str,
) -> AppResult<()> {
    let network = crate::db::settings::load_checked(conn)
        .map_err(|_| AppError::validation("network.configurationChanged"))?
        .network;
    current(expected, &network, plugin)
}

async fn available<T>(
    db: &crate::db::Database,
    expires: tokio::time::Instant,
    mut read: impl FnMut(&rusqlite::Connection) -> AppResult<T>,
) -> AppResult<T> {
    loop {
        if tokio::time::Instant::now() >= expires {
            return Err(AppError::validation("network.timeout"));
        }
        if let Some(value) = db.try_with(&mut read)? {
            return Ok(value);
        }
        tokio::time::sleep_until(
            expires.min(tokio::time::Instant::now() + Duration::from_millis(5)),
        )
        .await;
    }
}

impl ProcessEnvironment {
    pub(crate) async fn capture(app: &AppHandle, plugin: &str) -> AppResult<Self> {
        let expires = tokio::time::Instant::now() + Duration::from_secs(15);
        let state = app.state::<AppState>();
        // Capture original persisted choice without blocking the runtime behind
        // an unrelated consumer retaining the DB mutex during an OS operation.
        let network = available(&state.db, expires, |conn| {
            Ok(crate::db::settings::load_checked(conn)?.network)
        })
        .await?;
        let selected = selected(&network, plugin)?;
        let app = app.clone();
        let plugin = plugin.to_owned();
        prepare(
            move || {
                // Reject changes while waiting for a worker before exposing a saved secret.
                verify(&app, &selected, &plugin)?;
                if tokio::time::Instant::now() >= expires {
                    return Err(AppError::validation("network.timeout"));
                }
                let url = proxy::url(
                    &app.state::<AppState>().vault,
                    &network,
                    "processes",
                    configured(&network, &plugin),
                )?;
                Ok(Self {
                    plugin,
                    selected,
                    url,
                    expires,
                })
            },
            expires.saturating_duration_since(tokio::time::Instant::now()),
        )
        .await
    }

    pub(crate) async fn apply_current(
        &self,
        app: &AppHandle,
        command: &mut Command,
    ) -> AppResult<()> {
        available(&app.state::<AppState>().db, self.expires, |conn| {
            verify_saved(conn, &self.selected, &self.plugin)?;
            if tokio::time::Instant::now() >= self.expires {
                return Err(AppError::validation("network.timeout"));
            }
            apply(self.url.as_deref(), command);
            Ok(())
        })
        .await
    }
}

// Dropped/expired preparation can complete its read but has no child or publication.
async fn prepare<T: Send + 'static>(
    read: impl FnOnce() -> AppResult<T> + Send + 'static,
    timeout: Duration,
) -> AppResult<T> {
    if timeout.is_zero() {
        return Err(AppError::validation("network.timeout"));
    }
    tokio::time::timeout(timeout, crate::services::credentials::inspect(read))
        .await
        .map_err(|_| AppError::validation("network.timeout"))?
}

fn apply(url: Option<&str>, command: &mut Command) {
    if let Some(url) = url {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            command.env_remove(key);
        }
        if !url.is_empty() {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env(key, url);
            }
            command
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .env("NODE_USE_ENV_PROXY", "1");
        } else {
            command.env_remove("NODE_USE_ENV_PROXY");
        }
    }
}

#[cfg(test)]
mod tests;
