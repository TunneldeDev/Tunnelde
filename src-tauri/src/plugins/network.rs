use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::{de::DeserializeOwned, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::network::requests::idempotent_get as request;
use crate::state::AppState;

type Jobs = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;
#[derive(Default)]
pub struct DownloadRegistry(Jobs);

use crate::network::diagnostics::redact_error_detail as diagnostic;

fn network_error(error: reqwest::Error) -> AppError {
    let timeout = error.is_timeout();
    let connect = error.is_connect();
    let body = error.is_body();
    let detail = diagnostic(&format!("{:?}", error.without_url()));
    tracing::warn!(
        timeout,
        connect,
        body,
        detail,
        "plugin HTTPS request failed"
    );
    let detail = detail.to_ascii_lowercase();
    AppError::validation(if timeout {
        "market.timeout"
    } else if detail.contains("tls") || detail.contains("handshake") {
        "market.tlsHandshake"
    } else if connect {
        "market.connectFailed"
    } else {
        "market.network"
    })
}

pub fn validate_url(url: &str) -> AppResult<reqwest::Url> {
    let value = reqwest::Url::parse(url).map_err(|_| AppError::validation("market.invalidUrl"))?;
    if value.scheme() != "https"
        || value.host_str().is_none()
        || !value.username().is_empty()
        || value.password().is_some()
        || value.fragment().is_some()
        || url.len() > 4096
    {
        return Err(AppError::validation("market.invalidUrl"));
    }
    Ok(value)
}

pub async fn fetch_json<T: DeserializeOwned>(
    app: &AppHandle,
    url: &str,
    max: usize,
) -> AppResult<T> {
    let client = crate::network::http_client(app, "marketplace").await?;
    let response = request(&client, validate_url(url)?, Duration::from_secs(25))
        .await
        .map_err(network_error)?;
    let bytes = read(response, max, None).await?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::validation("market.invalidCatalogue"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    task_id: &'a str,
    phase: &'a str,
    received: u64,
    total: Option<u64>,
}

pub struct DownloadTask {
    app: AppHandle,
    id: String,
    cancelled: Arc<AtomicBool>,
    jobs: Jobs,
}

impl DownloadTask {
    pub fn begin(app: &AppHandle, id: &str) -> AppResult<Self> {
        if id.is_empty() || id.len() > 160 {
            return Err(AppError::validation("market.invalidTask"));
        }
        let jobs = app.state::<AppState>().downloads.0.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut map = jobs.lock().map_err(|_| AppError::internal("market.lock"))?;
            if map.contains_key(id) {
                return Err(AppError::validation("market.busy"));
            }
            map.insert(id.to_owned(), cancelled.clone());
        }
        let task = Self {
            app: app.clone(),
            id: id.to_owned(),
            cancelled,
            jobs,
        };
        task.progress("connecting", 0, None);
        Ok(task)
    }

    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(AppError::validation("market.cancelled"))
        } else {
            Ok(())
        }
    }

    pub fn progress(&self, phase: &str, received: u64, total: Option<u64>) {
        let _ = self.app.emit(
            "plugins://download",
            Progress {
                task_id: &self.id,
                phase,
                received,
                total,
            },
        );
    }

    pub async fn download(&self, url: &str, max: usize) -> AppResult<Vec<u8>> {
        self.check()?;
        let client = prepare_download(
            &self.cancelled,
            crate::network::http_client(&self.app, "marketplace"),
        )
        .await?;
        let request = request(&client, validate_url(url)?, Duration::from_secs(300));
        let response = tokio::select! {
            biased;
            _ = self.wait_cancel() => return Err(AppError::validation("market.cancelled")),
            result = request => result.map_err(network_error)?,
        };
        read(response, max, Some(self)).await
    }

    pub(super) async fn wait_cancel(&self) {
        wait_cancelled(&self.cancelled).await;
    }
}

// Preparation may wait for a system credential prompt. Cancellation covers that
// wait as well as the request, and is rechecked before the caller can issue GET.
async fn prepare_download<T>(
    cancelled: &AtomicBool,
    preparation: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let value = tokio::select! {
        biased;
        _ = wait_cancelled(cancelled) => return Err(AppError::validation("market.cancelled")),
        result = preparation => result?,
    };
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::validation("market.cancelled"));
    }
    Ok(value)
}

async fn wait_cancelled(cancelled: &AtomicBool) {
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

impl Drop for DownloadTask {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}

pub fn cancel(app: &AppHandle, id: &str) -> bool {
    let state = app.state::<AppState>();
    let Ok(jobs) = state.downloads.0.lock() else {
        return false;
    };
    if let Some(flag) = jobs.get(id) {
        flag.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

async fn read(
    mut response: reqwest::Response,
    max: usize,
    task: Option<&DownloadTask>,
) -> AppResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(AppError::validation("market.http"));
    }
    let total = response.content_length();
    if total.is_some_and(|size| size > max as u64) {
        return Err(AppError::validation("market.tooLarge"));
    }
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(max as u64) as usize);
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        let chunk = if let Some(task) = task {
            tokio::select! {
                result = response.chunk() => result.map_err(network_error)?,
                _ = task.wait_cancel() => return Err(AppError::validation("market.cancelled")),
            }
        } else {
            response.chunk().await.map_err(network_error)?
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err(AppError::validation("market.tooLarge"));
        }
        bytes.extend_from_slice(&chunk);
        if let Some(task) = task {
            task.check()?;
            if last.elapsed() >= Duration::from_millis(100) {
                task.progress("downloading", bytes.len() as u64, total);
                last = Instant::now();
            }
        }
    }
    if let Some(task) = task {
        task.check()?;
        task.progress("downloaded", bytes.len() as u64, total);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
