use std::time::Duration;

use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;

use super::channels::{channel_accepts, source_channels};
use super::{validate_preferences, RELEASES_PAGE};
use crate::error::{AppError, AppResult};
use crate::settings::Settings;

const RELEASES_API: &str =
    "https://api.github.com/repos/TunneldeDev/Tunnelde/releases?per_page=100";

const MAX_FEED_BYTES: usize = 4 * 1024 * 1024;

fn network_error(error: reqwest::Error) -> AppError {
    let source = source_kind(error.url());
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
        stage = if body { "response-body" } else { "request" },
        timeout,
        connect,
        body,
        detail,
        reason = key,
        action = "check_update_proxy_and_retry",
        "update request failed"
    );
    AppError::Update(key.into())
}

pub(super) async fn request(client: &reqwest::Client, url: &str) -> AppResult<reqwest::Response> {
    client
        .get(url)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(network_error)
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

fn status_error(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    source: &str,
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
    AppError::Update(
        if limited {
            "updates.rateLimited"
        } else {
            "updates.sourceUnavailable"
        }
        .into(),
    )
}

pub(super) async fn read_response(mut response: reqwest::Response) -> AppResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(status_error(
            response.status(),
            response.headers(),
            source_kind(Some(response.url())),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_FEED_BYTES as u64)
    {
        return Err(AppError::Update("updates.invalidFeed".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
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
            page: RELEASES_PAGE.into(),
        }]);
    }
    let client = crate::network::http_client(app, "updates")?;
    Ok(vec![
        discover_github_feed(&client, &settings.update_channel).await?,
    ])
}

async fn discover_github_feed(client: &reqwest::Client, channel: &str) -> AppResult<Feed> {
    // Reserve time for a public-feed fallback within the overall check deadline.
    // Both routes use the exact same configured update proxy.
    let primary = tokio::time::timeout(Duration::from_secs(22), api_feed(client, channel))
        .await
        .unwrap_or_else(|_| Err(AppError::Update("updates.timeout".into())));
    match primary {
        Ok(feed) => Ok(feed),
        Err(primary) => {
            tracing::info!(reason = %primary, channel, source = "github-api", next_source = "github-public-feed", action = "automatic_fallback", "GitHub update API unavailable; checking recent public releases");
            let fallback = tokio::time::timeout(
                Duration::from_secs(28),
                super::atom::fallback(client, channel),
            )
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
                    if primary.to_string() == "updates.rateLimited"
                        && fallback.to_string() == "updates.sourceUnavailable"
                    {
                        Err(primary)
                    } else {
                        Err(fallback)
                    }
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
mod tests {
    use super::*;

    #[test]
    fn source_labels_never_expose_custom_urls_or_credentials() {
        for (url, expected) in [
            (
                "https://api.github.com/repos/TunneldeDev/Tunnelde/releases?secret=hidden",
                "github-api",
            ),
            (
                "https://github.com/TunneldeDev/Tunnelde/releases.atom",
                "github-public-feed",
            ),
            (
                "https://github.com/TunneldeDev/Tunnelde/releases/download/v1/latest.json",
                "github-release",
            ),
            (
                "https://user:secret@private.example/feed?token=hidden",
                "custom-update-source",
            ),
        ] {
            assert_eq!(source_kind(Some(&url.parse().unwrap())), expected);
        }
    }

    #[test]
    fn quota_log_includes_actionable_allowlisted_response_context() {
        use std::{
            io::Write,
            sync::{Arc, Mutex},
        };
        #[derive(Clone)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let buffer = Buffer(bytes.clone());
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || buffer.clone())
            .finish();
        let mut headers = reqwest::header::HeaderMap::new();
        for (key, value) in [
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-limit", "60"),
            ("x-ratelimit-reset", "1800000000"),
            ("retry-after", "120"),
            ("x-github-request-id", "ABCD:1234"),
            ("authorization", "Bearer secret-token"),
        ] {
            headers.insert(
                reqwest::header::HeaderName::from_static(key),
                value.parse().unwrap(),
            );
        }
        tracing::subscriber::with_default(subscriber, || {
            let _ = status_error(reqwest::StatusCode::FORBIDDEN, &headers, "github-api");
        });
        let output = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        assert!(!output.contains("secret-token"));
        let event: serde_json::Value = serde_json::from_str(output.trim()).unwrap();
        let fields = &event["fields"];
        assert_eq!(fields["source"], "github-api");
        assert_eq!(fields["stage"], "http-response");
        assert_eq!(fields["status"], 403);
        assert_eq!(fields["limited"], true);
        assert_eq!(fields["request_id"], "ABCD:1234");
        assert_eq!(fields["rate_limit_remaining"], 0);
        assert_eq!(fields["rate_limit_limit"], 60);
        assert_eq!(fields["rate_limit_reset_unix"], 1800000000);
        assert_eq!(fields["retry_after_seconds"], 120);
        assert_eq!(fields["action"], "try_public_feed_then_retry_later");
    }

    #[test]
    fn github_lexical_beta_order_never_controls_update_selection() {
        // Captured ordering from GitHub on 2026-11-04: beta.9 precedes .11 and .10.
        let tags = [
            "v0.28.0-beta.9",
            "v0.28.0-beta.8",
            "v0.28.0-beta.2",
            "v0.28.0-beta.11",
            "v0.28.0-beta.10",
            "v0.28.0-beta.1",
            "v0.27.1",
        ];
        let mut releases: Vec<GitHubRelease> = tags
            .iter()
            .map(|tag| GitHubRelease {
                tag_name: (*tag).into(),
                draft: false,
                prerelease: tag.contains('-'),
                assets: vec![ReleaseAsset {
                    name: "latest.json".into(),
                }],
                body: Some(format!("Notes for {tag}")),
            })
            .collect();
        for channel in ["beta", "nightly"] {
            let feed = github_channel_feed(&releases, channel).unwrap();
            assert_eq!(
                feed.version.unwrap(),
                Version::parse("0.28.0-beta.11").unwrap()
            );
            assert!(feed.url.as_str().ends_with("/v0.28.0-beta.11/latest.json"));
            assert_eq!(feed.notes.as_deref(), Some("Notes for v0.28.0-beta.11"));
        }
        assert_eq!(
            github_channel_feed(&releases, "stable")
                .unwrap()
                .version
                .unwrap(),
            Version::parse("0.27.1").unwrap()
        );
        for tag in ["v0.28.0-beta.99", "v0.28.0-beta.100", "v0.29.0-beta.1"] {
            releases.push(GitHubRelease {
                tag_name: tag.into(),
                draft: false,
                prerelease: true,
                assets: vec![ReleaseAsset {
                    name: "latest.json".into(),
                }],
                body: None,
            });
            assert_eq!(
                github_channel_feed(&releases, "beta")
                    .unwrap()
                    .version
                    .unwrap(),
                Version::parse(&tag[1..]).unwrap()
            );
        }
        // Incomplete or mismarked releases never supersede verified channel packages.
        releases.push(GitHubRelease {
            tag_name: "v0.29.0-beta.2".into(),
            draft: true,
            prerelease: true,
            assets: vec![ReleaseAsset {
                name: "latest.json".into(),
            }],
            body: None,
        });
        releases.push(GitHubRelease {
            tag_name: "v0.29.0-beta.3".into(),
            draft: false,
            prerelease: true,
            assets: vec![],
            body: None,
        });
        releases.push(GitHubRelease {
            tag_name: "v0.29.0-beta.4".into(),
            draft: false,
            prerelease: false,
            assets: vec![ReleaseAsset {
                name: "latest.json".into(),
            }],
            body: None,
        });
        releases.reverse();
        assert_eq!(
            github_channel_feed(&releases, "beta")
                .unwrap()
                .version
                .unwrap(),
            Version::parse("0.29.0-beta.1").unwrap()
        );
    }

    #[tokio::test]
    #[ignore = "requires a reachable explicit proxy and live GitHub releases"]
    async fn live_channels_through_configured_proxy() {
        let proxy = std::env::var("TUNNELDE_UPDATE_TEST_PROXY").expect("explicit test proxy");
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy).unwrap())
            .user_agent("Tunnelde-update-regression")
            .build()
            .unwrap();
        for channel in ["beta", "nightly"] {
            let feed = discover_github_feed(&client, channel).await.unwrap();
            let expected = feed.version.as_ref().unwrap();
            assert!(channel_accepts(expected, channel));
            let bytes = read_response(request(&client, feed.url.as_str()).await.unwrap())
                .await
                .unwrap();
            let manifest: tauri_plugin_updater::RemoteRelease =
                serde_json::from_slice(&bytes).unwrap();
            assert_eq!(&manifest.version, expected);
            println!("{channel}: {expected}; manifest verified");
        }
        // Exercise the quota-independent path even if the proxy's API quota reset.
        let feed = super::super::atom::fallback(&client, "nightly")
            .await
            .unwrap();
        println!("public-feed fallback: {}", feed.version.unwrap());
    }

    #[test]
    fn identifies_rate_limits_without_mistaking_all_forbidden_responses_for_quota() {
        use reqwest::{header::HeaderMap, StatusCode};
        let mut headers = HeaderMap::new();
        assert_eq!(
            status_error(StatusCode::FORBIDDEN, &headers, "github-api").to_string(),
            "updates.sourceUnavailable"
        );
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert_eq!(
            status_error(StatusCode::FORBIDDEN, &headers, "github-api").to_string(),
            "updates.rateLimited"
        );
        assert_eq!(
            status_error(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                "github-api"
            )
            .to_string(),
            "updates.rateLimited"
        );
    }

    #[tokio::test]
    async fn rejects_oversized_and_chunked_feeds() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for chunked in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                assert!(stream.read(&mut request).await.unwrap() > 0);
                if chunked {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await;
                    let data = vec![b'x'; 1024 * 1024];
                    for _ in 0..5 {
                        if stream.write_all(b"100000\r\n").await.is_err() {
                            break;
                        }
                        if stream.write_all(&data).await.is_err() {
                            break;
                        }
                        if stream.write_all(b"\r\n").await.is_err() {
                            break;
                        }
                    }
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                } else {
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n")
                        .await;
                }
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            assert_eq!(
                read_response(request(&client, &url).await.unwrap())
                    .await
                    .err()
                    .unwrap()
                    .to_string(),
                "updates.invalidFeed"
            );
            task.await.unwrap();
        }
    }
}
