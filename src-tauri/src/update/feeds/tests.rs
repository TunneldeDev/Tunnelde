use super::*;

fn limited() -> AppError {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
    headers.insert("retry-after", "120".parse().unwrap());
    status_error(reqwest::StatusCode::FORBIDDEN, &headers, "github-api")
}

fn test_feed() -> Feed {
    Feed {
        url: "https://github.com/TunneldeDev/Tunnelde/releases/download/v1.0.0/latest.json"
            .parse()
            .unwrap(),
        channel: "beta".into(),
        version: Some(Version::new(1, 0, 0)),
        page: String::new(),
        notes: None,
        manifest: None,
    }
}

#[tokio::test]
async fn discovery_preserves_both_failures_and_retries_public_feed_during_api_backoff() {
    use std::cell::Cell;
    let api_calls = Cell::new(0);
    let public_calls = Cell::new(0);
    let backoff = ApiBackoff::default();
    let error = discover_sources(
        "beta",
        &backoff,
        42,
        || async {
            api_calls.set(api_calls.get() + 1);
            Err(limited())
        },
        || async {
            public_calls.set(public_calls.get() + 1);
            Err(AppError::Update("updates.timeout".into()))
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "updates.sourcesUnavailable");
    let wire = serde_json::to_value(&error).unwrap();
    assert_eq!(wire["code"], "update");
    let failures = wire["details"]["sourceErrors"].as_array().unwrap();
    assert_eq!(failures.len(), 2);
    assert_eq!(failures[0]["source"], "github-api");
    assert_eq!(failures[0]["reason"], "updates.rateLimited");
    assert_eq!(failures[0]["status"], 403);
    assert!(failures[0]["retryAt"].as_i64().unwrap() > now_ms());
    assert_eq!(failures[1]["source"], "github-public-feed");
    assert_eq!(failures[1]["reason"], "updates.timeout");
    let result = discover_sources(
        "beta",
        &backoff,
        42,
        || async {
            api_calls.set(api_calls.get() + 1);
            Ok(test_feed())
        },
        || async {
            public_calls.set(public_calls.get() + 1);
            Ok(test_feed())
        },
    )
    .await
    .unwrap();
    assert_eq!(result.version, Some(Version::new(1, 0, 0)));
    assert_eq!(api_calls.get(), 1);
    assert_eq!(public_calls.get(), 2);
    discover_sources(
        "beta",
        &backoff,
        43,
        || async {
            api_calls.set(api_calls.get() + 1);
            Ok(test_feed())
        },
        || async { panic!("a successful API should not request the public feed") },
    )
    .await
    .unwrap();
    assert_eq!(api_calls.get(), 2);
}

#[test]
fn backoff_expires_and_non_quota_failures_do_not_suppress_requests() {
    let backoff = ApiBackoff::default();
    let mut failure = source_failure("github-api", limited());
    failure.retry_at = Some(120_000);
    backoff.record(42, &failure);
    assert!(backoff.active(42, 119_999).is_some());
    assert!(backoff.active(42, 120_000).is_none());
    assert!(backoff.active(43, 119_999).is_none());
    backoff.record(
        43,
        &source_failure("github-api", AppError::Update("updates.timeout".into())),
    );
    assert!(backoff.active(43, 0).is_none());
}

#[test]
fn retry_deadline_respects_headers_and_rejects_overflow_and_past_values() {
    let now = 1_800_000_000_000;
    for (after, reset, expected) in [
        ("120", "1800000180", now + 180_000),
        ("120", "1800000001", now + 120_000),
        ("18446744073709551615", "18446744073709551615", now + 60_000),
        ("invalid", "1700000000", now + 60_000),
        ("Sun, 15 Jan 2027 08:02:00 GMT", "0", now + 60_000),
    ] {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", after.parse().unwrap());
        headers.insert("x-ratelimit-reset", reset.parse().unwrap());
        assert_eq!(retry_at(&headers, now), expected);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    let after = chrono::DateTime::from_timestamp_millis(now + 120_000)
        .unwrap()
        .to_rfc2822();
    headers.insert("retry-after", after.parse().unwrap());
    assert_eq!(retry_at(&headers, now), now + 120_000);
    let forbidden = status_error(
        reqwest::StatusCode::FORBIDDEN,
        &Default::default(),
        "github-api",
    );
    assert_eq!(forbidden.to_string(), "updates.sourceUnavailable");
    assert!(forbidden.update_source_errors().unwrap()[0]
        .retry_at
        .is_none());
}

#[tokio::test]
async fn manifest_transport_keeps_http_status_and_retry_context_and_accepts_no_content() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, extra, body, expected) in [
        (
            "403 Forbidden",
            "x-ratelimit-remaining: 0\r\nretry-after: 120\r\n",
            "",
            Some("updates.rateLimited"),
        ),
        ("404 Not Found", "", "", Some("updates.sourceUnavailable")),
        ("502 Bad Gateway", "", "", Some("updates.sourceUnavailable")),
        ("200 OK", "", "broken JSON", Some("updates.invalidFeed")),
        ("204 No Content", "", "", None),
        ("200 OK", "", r#"{"version":"1.0.0","platforms":{}}"#, None),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: reqwest::Url = format!("http://{}/latest.json", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let task = tokio::spawn(async move {
            for _ in 0..if status.starts_with("502") { 2 } else { 1 } {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let size = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..size]);
                assert!(request
                    .to_ascii_lowercase()
                    .contains("accept: application/json"));
                socket.write_all(format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = manifest(&client, &url).await;
        if let Some(reason) = expected {
            let error = result.unwrap_err();
            assert_eq!(error.to_string(), reason);
            let failures = error.update_source_errors().unwrap();
            assert_eq!(failures[0].source, "custom-update-source");
            if !status.starts_with("200") {
                assert_eq!(failures[0].status, Some(status[..3].parse().unwrap()));
            }
            assert_eq!(
                failures[0].retry_at.is_some(),
                reason == "updates.rateLimited"
            );
        } else {
            assert_eq!(result.unwrap().is_none(), status.starts_with("204"));
        }
        task.await.unwrap();
    }
}

#[tokio::test]
async fn gateway_retry_recovers_once_and_preserves_final_status_without_retrying_other_errors() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for statuses in [
        vec![502, 200],
        vec![503, 200],
        vec![504, 200],
        vec![504, 504],
        vec![401],
        vec![403],
        vec![404],
        vec![429],
        vec![500],
    ] {
        let expected = *statuses.last().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for status in statuses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}" ).as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            request_with_timeout(&client, &url, Duration::from_secs(2), false),
        )
        .await
        .expect("retry must be bounded")
        .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        if expected == 200 {
            assert_eq!(read_response(response).await.unwrap(), b"{}");
        } else {
            assert_eq!(
                read_response(response)
                    .await
                    .unwrap_err()
                    .update_source_errors()
                    .unwrap()[0]
                    .status,
                Some(expected)
            );
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn retry_wait_and_response_body_share_the_original_request_deadline() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for status in [504, 200] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            if status == 504 {
                socket.write_all(b"HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            } else {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{",
                    )
                    .await
                    .unwrap();
                // A retry must not reset the budget once headers arrive.
                std::future::pending::<()>().await;
            }
        }
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let started = tokio::time::Instant::now();
    let result = tokio::time::timeout(Duration::from_millis(1100), async {
        let response =
            request_with_timeout(&client, &url, Duration::from_millis(700), false).await?;
        read_response(response).await
    })
    .await
    .expect("headers, retry wait and body must share the 700ms budget");
    assert_eq!(result.unwrap_err().to_string(), "updates.timeout");
    assert!(started.elapsed() >= Duration::from_millis(600));
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn body_timeouts_keep_known_github_source_and_response_body_stage() {
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tracing::instrument::WithSubscriber;
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
    for (host, path, source) in [
        (
            "api.github.com",
            "/repos/TunneldeDev/Tunnelde/releases",
            "github-api",
        ),
        (
            "github.com",
            "/TunneldeDev/Tunnelde/releases.atom",
            "github-public-feed",
        ),
        (
            "github.com",
            "/TunneldeDev/Tunnelde/releases/download/v1/latest.json",
            "github-release",
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!(
            "http://{host}:{}{path}?token=secret-test-token",
            addr.port()
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve(host, addr)
            .build()
            .unwrap();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let buffer = Buffer(bytes.clone());
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || buffer.clone())
            .finish();
        let error = async {
            let response = request_with_timeout(&client, &url, Duration::from_millis(250), false)
                .await
                .unwrap();
            read_response(response).await.unwrap_err()
        }
        .with_subscriber(subscriber)
        .await;
        assert_eq!(error.to_string(), "updates.timeout");
        assert_eq!(error.update_source_errors().unwrap()[0].source, source);
        let output = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        let entry: serde_json::Value = output
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|entry| entry["fields"]["message"] == "update request failed")
            .expect("body failure diagnostic");
        assert_eq!(entry["fields"]["source"], source);
        assert_eq!(entry["fields"]["stage"], "response-body");
        assert_eq!(entry["fields"]["timeout"], true);
        assert!(!output.contains("secret-test-token"));
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}

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
        let feed = discover_github_feed(&client, channel, &ApiBackoff::default(), 0)
            .await
            .unwrap();
        let expected = feed.version.as_ref().unwrap();
        assert!(channel_accepts(expected, channel));
        let bytes = read_response(request(&client, feed.url.as_str()).await.unwrap())
            .await
            .unwrap();
        let manifest: tauri_plugin_updater::RemoteRelease = serde_json::from_slice(&bytes).unwrap();
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
