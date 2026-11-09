use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::channels::{channel_accepts, source_channels};
use super::{validate_preferences, RELEASES_PAGE};
use crate::error::{AppError, AppResult, UpdateSourceFailure};
use crate::models::now_ms;
use crate::settings::Settings;
use crate::state::AppState;

const RELEASES_API: &str =
    "https://api.github.com/repos/TunneldeDev/Tunnelde/releases?per_page=100";

const MAX_FEED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub(super) struct ApiBackoff(Mutex<Option<(u64, UpdateSourceFailure)>>);

impl ApiBackoff {
    fn active(&self, proxy: u64, now: i64) -> Option<UpdateSourceFailure> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|(key, failure)| *key == proxy && failure.retry_at.is_some_and(|at| at > now))
            .map(|(_, failure)| failure.clone())
    }

    fn record(&self, proxy: u64, failure: &UpdateSourceFailure) {
        if failure.reason == "updates.rateLimited" {
            *self.0.lock().unwrap_or_else(|error| error.into_inner()) =
                Some((proxy, failure.clone()));
        }
    }
}

fn proxy_fingerprint(settings: &Settings) -> AppResult<u64> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Never store or log a proxy URL, password, or serialized network settings.
    crate::network::proxy_url(&settings.network, "updates", None)?.hash(&mut hasher);
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] {
        std::env::var_os(name).hash(&mut hasher);
    }
    Ok(hasher.finish())
}

fn source_failure(source: &'static str, error: AppError) -> UpdateSourceFailure {
    if let AppError::UpdateRequest(failure) = error {
        failure
    } else {
        UpdateSourceFailure {
            source,
            reason: error.to_string(),
            status: None,
            retry_at: None,
        }
    }
}

fn network_error(error: reqwest::Error, source: &'static str, stage: &'static str) -> AppError {
    let timeout = error.is_timeout();
    let connect = error.is_connect();
    let body = error.is_body();
    let key = if error.is_timeout() {
        "updates.timeout"
    } else if error.is_connect() {
        "updates.connectionFailed"
    } else {
        "updates.sourceUnavailable"
    };
    let detail =
        crate::network::diagnostics::redact_error_detail(&format!("{:?}", error.without_url()));
    tracing::debug!(
        source,
        stage,
        timeout,
        connect,
        body,
        detail,
        reason = key,
        action = "check_update_proxy_and_retry",
        "update request failed"
    );
    AppError::UpdateRequest(UpdateSourceFailure {
        source,
        reason: key.into(),
        status: None,
        retry_at: None,
    })
}

pub(super) async fn request(client: &reqwest::Client, url: &str) -> AppResult<reqwest::Response> {
    request_with_timeout(client, url, Duration::from_secs(12), false).await
}

async fn request_with_timeout(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
    json: bool,
) -> AppResult<reqwest::Response> {
    let parsed = reqwest::Url::parse(url).ok();
    let source = source_kind(parsed.as_ref());
    // Retry only explicit transient gateway failures, once, inside the original
    // request budget. Never retry quota/auth/not-found or bypass the chosen proxy.
    let deadline = tokio::time::Instant::now() + timeout;
    for attempt in 0..2 {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            tracing::debug!(
                source,
                stage = "request",
                reason = "updates.timeout",
                action = "check_update_proxy_and_retry",
                "update request deadline exhausted"
            );
            return Err(AppError::UpdateRequest(UpdateSourceFailure {
                source,
                reason: "updates.timeout".into(),
                status: None,
                retry_at: None,
            }));
        }
        let mut request = client.get(url).timeout(remaining);
        if json {
            request = request.header(reqwest::header::ACCEPT, "application/json");
        }
        let response = request
            .send()
            .await
            .map_err(|error| network_error(error, source, "request"))?;
        if attempt == 0
            && matches!(response.status().as_u16(), 502..=504)
            && deadline.saturating_duration_since(tokio::time::Instant::now())
                > Duration::from_millis(500)
        {
            tracing::debug!(
                source,
                stage = "http-response",
                status = response.status().as_u16(),
                attempt = 1,
                next_attempt = 2,
                action = "retry_same_update_source",
                "transient update gateway failure; retrying within request deadline"
            );
            drop(response);
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        return Ok(response);
    }
    unreachable!("the final request attempt always returns")
}

pub(super) async fn manifest(
    client: &reqwest::Client,
    url: &reqwest::Url,
) -> AppResult<Option<serde_json::Value>> {
    let response = manifest_response(client, url).await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let bytes = read_response(response).await.map_err(|error| match error {
        AppError::UpdateRequest(_) => error,
        _ => manifest_error(url, "updates.invalidFeed"),
    })?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| manifest_error(url, "updates.invalidFeed"))
}

pub(super) async fn manifest_response(
    client: &reqwest::Client,
    url: &reqwest::Url,
) -> AppResult<reqwest::Response> {
    request_with_timeout(client, url.as_str(), Duration::from_secs(25), true).await
}

pub(super) fn manifest_error(url: &reqwest::Url, reason: &'static str) -> AppError {
    let source = source_kind(Some(url));
    tracing::debug!(
        source,
        stage = "manifest-validation",
        reason,
        action = "check_update_source_and_proxy",
        "update manifest could not be used"
    );
    AppError::UpdateRequest(UpdateSourceFailure {
        source,
        reason: reason.into(),
        status: None,
        retry_at: None,
    })
}

fn source_kind(url: Option<&reqwest::Url>) -> &'static str {
    match url.and_then(reqwest::Url::host_str) {
        Some("api.github.com") => "github-api",
        Some("github.com") if url.is_some_and(|url| url.path().ends_with(".atom")) => {
            "github-public-feed"
        }
        Some(
            "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com",
        ) => "github-release",
        _ => "custom-update-source",
    }
}

fn header_number(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}

fn retry_at(headers: &reqwest::header::HeaderMap, now: i64) -> i64 {
    let after = headers.get(reqwest::header::RETRY_AFTER).and_then(|value| {
        let value = value.to_str().ok()?;
        value
            .parse::<u64>()
            .ok()
            .and_then(|seconds| i64::try_from(seconds).ok())
            .and_then(|seconds| seconds.checked_mul(1000))
            .and_then(|milliseconds| now.checked_add(milliseconds))
            .or_else(|| {
                chrono::DateTime::parse_from_rfc2822(value)
                    .ok()
                    .map(|date| date.timestamp_millis())
            })
    });
    let reset = header_number(headers, "x-ratelimit-reset")
        .and_then(|seconds| i64::try_from(seconds).ok())
        .and_then(|seconds| seconds.checked_mul(1000));
    [after, reset]
        .into_iter()
        .flatten()
        .filter(|time| *time > now && *time <= now.saturating_add(7 * 86_400_000))
        .max()
        .unwrap_or_else(|| now.saturating_add(60_000))
}

fn status_error(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    source: &'static str,
) -> AppError {
    let limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && (headers
                .get("x-ratelimit-remaining")
                .is_some_and(|value| value == "0")
                || headers.contains_key(reqwest::header::RETRY_AFTER)));
    tracing::debug!(
        source,
        stage = "http-response",
        status = status.as_u16(),
        limited,
        rate_limit_remaining = header_number(headers, "x-ratelimit-remaining"),
        rate_limit_limit = header_number(headers, "x-ratelimit-limit"),
        rate_limit_reset_unix = header_number(headers, "x-ratelimit-reset"),
        retry_after_seconds = header_number(headers, "retry-after"),
        request_id = headers
            .get("x-github-request-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b":-".contains(&byte)))
            .unwrap_or("unavailable"),
        action = if limited && source == "github-api" {
            "try_public_feed_then_retry_later"
        } else if limited {
            "retry_later"
        } else {
            "check_update_source_and_proxy"
        },
        "update source returned an error"
    );
    AppError::UpdateRequest(UpdateSourceFailure {
        source,
        reason: if limited {
            "updates.rateLimited"
        } else {
            "updates.sourceUnavailable"
        }
        .into(),
        status: Some(status.as_u16()),
        retry_at: limited.then(|| retry_at(headers, now_ms())),
    })
}

pub(super) async fn read_response(mut response: reqwest::Response) -> AppResult<Vec<u8>> {
    // reqwest body/decode errors often carry no URL. Preserve known response
    // context instead of misclassifying the GitHub API as a custom source.
    let source = source_kind(Some(response.url()));
    if !response.status().is_success() {
        return Err(status_error(response.status(), response.headers(), source));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_FEED_BYTES as u64)
    {
        return Err(AppError::Update("updates.invalidFeed".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network_error(error, source, "response-body"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_FEED_BYTES {
            return Err(AppError::Update("updates.invalidFeed".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Debug, Deserialize)]
pub(super) struct ReleaseAsset {
    pub(super) name: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct GitHubRelease {
    pub(super) tag_name: String,
    pub(super) draft: bool,
    pub(super) prerelease: bool,
    pub(super) assets: Vec<ReleaseAsset>,
    #[serde(default)]
    pub(super) body: Option<String>,
}

pub(super) struct Feed {
    pub(super) url: reqwest::Url,
    pub(super) channel: String,
    pub(super) version: Option<Version>,
    pub(super) page: String,
    pub(super) notes: Option<String>,
    pub(super) manifest: Option<serde_json::Value>,
}

pub(super) fn github_channel_feed(releases: &[GitHubRelease], channel: &str) -> AppResult<Feed> {
    let (version, release) = releases
        .iter()
        .filter(|release| !release.draft && release.assets.iter().any(|a| a.name == "latest.json"))
        .filter_map(|release| {
            let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
            let eligible =
                release.prerelease != version.pre.is_empty() && channel_accepts(&version, channel);
            eligible.then_some((version, release))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .ok_or_else(|| AppError::Update("updates.noFeed".into()))?;
    let tag = &release.tag_name;
    Ok(Feed {
        url: format!("https://github.com/TunneldeDev/Tunnelde/releases/download/{tag}/latest.json")
            .parse()
            .map_err(|_| AppError::Update("updates.noFeed".into()))?,
        channel: channel.into(),
        version: Some(version),
        page: format!("https://github.com/TunneldeDev/Tunnelde/releases/tag/{tag}"),
        notes: release.body.clone(),
        manifest: None,
    })
}

pub(super) async fn feeds(app: &AppHandle, settings: &Settings) -> AppResult<Vec<Feed>> {
    validate_preferences(settings)?;
    if settings.update_source == "custom" {
        if settings.update_source_url.is_empty() {
            return Err(AppError::validation("updates.invalidSource"));
        }
        return source_channels(&settings.update_channel)
            .iter()
            .map(|channel| {
                Ok(Feed {
                    url: settings
                        .update_source_url
                        .replace("{channel}", channel)
                        .parse()
                        .map_err(|_| AppError::validation("updates.invalidSource"))?,
                    // The chosen channel accepts releases from every queried endpoint.
                    channel: settings.update_channel.clone(),
                    version: None,
                    notes: None,
                    manifest: None,
                    page: if *channel == "stable" {
                        RELEASES_PAGE.into()
                    } else {
                        "https://github.com/TunneldeDev/Tunnelde/releases".into()
                    },
                })
            })
            .collect();
    }
    if settings.update_channel == "stable" {
        return Ok(vec![Feed {
            url: format!("{RELEASES_PAGE}/download/latest.json")
                .parse()
                .unwrap(),
            channel: "stable".into(),
            version: None,
            notes: None,
            manifest: None,
            page: RELEASES_PAGE.into(),
        }]);
    }
    let client = crate::network::http_client(app, "updates")?;
    let service = app.state::<AppState>();
    Ok(vec![
        discover_github_feed(
            &client,
            &settings.update_channel,
            &service.update.github_api_backoff,
            proxy_fingerprint(settings)?,
        )
        .await?,
    ])
}

async fn discover_github_feed(
    client: &reqwest::Client,
    channel: &str,
    backoff: &ApiBackoff,
    proxy: u64,
) -> AppResult<Feed> {
    discover_sources(
        channel,
        backoff,
        proxy,
        || api_feed(client, channel),
        || super::atom::fallback(client, channel),
    )
    .await
}

async fn discover_sources<A, B, AF, BF>(
    channel: &str,
    backoff: &ApiBackoff,
    proxy: u64,
    api: A,
    public: B,
) -> AppResult<Feed>
where
    A: FnOnce() -> AF,
    B: FnOnce() -> BF,
    AF: std::future::Future<Output = AppResult<Feed>>,
    BF: std::future::Future<Output = AppResult<Feed>>,
{
    // Reserve time for a public-feed fallback within the overall check deadline.
    // Both routes use the exact same configured update proxy.
    let primary = if let Some(failure) = backoff.active(proxy, now_ms()) {
        tracing::debug!(
            source = "github-api",
            retry_at = failure.retry_at,
            action = "respect_rate_limit",
            "skipping rate-limited update API; public feed remains available"
        );
        Err(AppError::UpdateRequest(failure))
    } else {
        tokio::time::timeout(Duration::from_secs(22), api())
            .await
            .unwrap_or_else(|_| Err(AppError::Update("updates.timeout".into())))
    };
    match primary {
        Ok(feed) => Ok(feed),
        Err(primary) => {
            let primary = source_failure("github-api", primary);
            backoff.record(proxy, &primary);
            tracing::info!(reason = %primary, channel, source = "github-api", next_source = "github-public-feed", action = "automatic_fallback", "GitHub update API unavailable; checking recent public releases");
            // A feed request (12s) plus a slow release-asset redirect/body (25s)
            // must fit. Leave five seconds inside the overall 65s check budget
            // after the 22s API attempt and 38s fallback.
            let fallback = tokio::time::timeout(Duration::from_secs(38), public())
                .await
                .unwrap_or_else(|_| Err(AppError::Update("updates.timeout".into())));
            match fallback {
                Ok(feed) => {
                    tracing::info!(
                        channel,
                        source = "github-public-feed",
                        version = feed.version.as_ref().map(ToString::to_string),
                        "public release feed fallback succeeded"
                    );
                    Ok(feed)
                }
                Err(fallback) => {
                    tracing::debug!(reason = %fallback, primary_reason = %primary, channel, source = "github-public-feed", action = "check_update_proxy_or_retry_later", "public release feed fallback failed");
                    Err(AppError::UpdateSources(vec![
                        primary,
                        source_failure("github-public-feed", fallback),
                    ]))
                }
            }
        }
    }
}

async fn api_feed(client: &reqwest::Client, channel: &str) -> AppResult<Feed> {
    let mut releases = Vec::new();
    // Retained release history can exceed one page. Never choose an obsolete package
    // simply because a newer Beta or stable release fell outside the first page.
    for page in 1..=10 {
        let response = request(client, &format!("{RELEASES_API}&page={page}")).await?;
        let has_next = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("rel=\"next\""));
        let bytes = read_response(response).await?;
        let batch = serde_json::from_slice::<Vec<GitHubRelease>>(&bytes)
            .map_err(|_| AppError::Update("updates.invalidFeed".into()))?;
        releases.extend(batch);
        if !has_next {
            return github_channel_feed(&releases, channel);
        }
    }
    Err(AppError::Update("updates.invalidFeed".into()))
}

#[cfg(test)]
mod tests;
