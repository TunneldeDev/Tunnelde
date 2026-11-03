use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::{de::DeserializeOwned, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

type Jobs = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;
#[derive(Default)]
pub struct DownloadRegistry(Jobs);

fn diagnostic(value: &str) -> String {
    // Source URLs may contain access tokens; proxy URLs may carry credentials.
    // Preserve the error chain while removing every URL-like span.
    let mut value = value.to_owned();
    for scheme in ["https://", "http://"] {
        let mut offset = 0;
        while let Some(start) = value[offset..].find(scheme).map(|index| index + offset) {
            let end = value[start..]
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, '"' | '\'' | ')' | ']' | '}')
                })
                .map(|index| start + index)
                .unwrap_or(value.len());
            value.replace_range(start..end, "[url]");
            offset = start + 5;
        }
    }
    value.chars().take(2048).collect()
}

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
    AppError::validation("market.network")
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
    let response = crate::network::http_client(app, "marketplace")?
        .get(validate_url(url)?)
        .timeout(Duration::from_secs(25))
        .send()
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
        let client = crate::network::http_client(&self.app, "marketplace")?;
        let request = client.get(validate_url(url)?).send();
        let response = tokio::select! {
            result = request => result.map_err(network_error)?,
            _ = self.wait_cancel() => return Err(AppError::validation("market.cancelled")),
        };
        read(response, max, Some(self)).await
    }

    pub(super) async fn wait_cancel(&self) {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
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
mod tests {
    use super::*;
    #[test]
    fn accepts_only_explicit_https_without_credentials() {
        assert!(validate_url("https://plugins.example.org/index.json?version=1").is_ok());
        for value in [
            "https://",
            "http://example.org/a",
            "file:///a",
            "https://u:p@example.org/a",
            "https://example.org/a#fragment",
        ] {
            assert!(validate_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn network_diagnostics_keep_causes_without_urls_or_tokens() {
        let result = diagnostic(
            r#"ConnectError("TLS UnknownIssuer", url: "https://user:secret@example.org/archive?token=secret", proxy: http://u:p@localhost:7890)"#,
        );
        assert!(result.contains("TLS UnknownIssuer"));
        assert!(!result.contains("secret"));
        assert!(!result.contains("u:p"));
        assert!(!result.contains("example.org"));
    }
}
