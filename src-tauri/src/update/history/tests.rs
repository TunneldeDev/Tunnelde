use super::*;
use crate::settings::Settings;
use serde_json::{json, Value};

fn builder(channel: &str) -> HistoryBuilder {
    let settings = Settings {
        update_channel: channel.into(),
        ..Settings::default()
    };
    let mut snapshot = UpdateState::new("0.27.1".into(), &settings);
    snapshot.version = Some("0.29.0".into());
    snapshot.notes = Some("Selected target notes".into());
    HistoryBuilder::new(&snapshot).unwrap()
}

fn release(tag: &str) -> Value {
    json!({"tag_name":tag, "draft":false, "prerelease":tag.contains('-'),
        "body":format!("Notes for {tag}"), "published_at":"2026-11-04T12:00:00Z"})
}

fn batch(values: Vec<Value>) -> Vec<Release> {
    serde_json::from_value(Value::Array(values)).unwrap()
}

#[test]
fn filters_exact_semver_range_and_channel_and_sorts_independent_of_github_order() {
    let mut values: Vec<_> = [
        "v0.28.0-beta.9",
        "v0.28.0-beta.11",
        "v0.28.0-beta.10",
        "v0.28.0",
        "v0.29.0",
        "v0.29.1",
        "v0.27.1",
        "v0.27.0",
        "plugins-v9.0.0",
        "v0.28.0-beta.1.d.2.gabcd",
        "v0.28.0-alpha.1",
    ]
    .iter()
    .map(|tag| release(tag))
    .collect();
    let mut draft = release("v0.28.1");
    draft["draft"] = json!(true);
    values.push(draft);
    let mut mismarked = release("v0.28.2");
    mismarked["prerelease"] = json!(true);
    values.push(mismarked);
    values.push(release("v0.28.0")); // Duplicate record.
    for (channel, expected) in [
        ("stable", vec!["0.29.0", "0.28.0"]),
        (
            "beta",
            vec![
                "0.29.0",
                "0.28.0",
                "0.28.0-beta.11",
                "0.28.0-beta.10",
                "0.28.0-beta.9",
            ],
        ),
    ] {
        let mut history = builder(channel);
        history.add(batch(values.clone()));
        let result = history.finish(true, None);
        assert!(result.complete);
        assert!(result.reason.is_none());
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.version.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            result.entries[0].notes.as_deref(),
            Some("Selected target notes")
        );
        assert_eq!(result.entries[0].published_at, Some(1793793600000));
    }
}

#[test]
fn target_is_preserved_when_history_is_missing_or_has_no_notes() {
    let mut history = builder("stable");
    history.add(batch(vec![release("v0.28.0")]));
    let result = history.finish(true, None);
    assert!(!result.complete);
    assert_eq!(
        result.reason.as_deref(),
        Some("updates.historyMissingTarget")
    );
    assert_eq!(
        result.entries[0].notes.as_deref(),
        Some("Selected target notes")
    );

    let mut history = builder("stable");
    let mut target = release("v0.29.0");
    target["body"] = Value::Null;
    target["published_at"] = json!("invalid");
    history.add(batch(vec![target]));
    let result = history.finish(true, None);
    assert!(result.complete);
    assert_eq!(
        result.entries[0].notes.as_deref(),
        Some("Selected target notes")
    );
    assert_eq!(result.entries[0].published_at, None);
}

#[test]
fn budgets_bound_utf8_notes_and_entry_count_without_claiming_completeness() {
    let mut history = builder("beta");
    let mut oversized = release("v0.28.0");
    oversized["body"] = json!("汉".repeat(MAX_NOTES));
    history.add(batch(vec![oversized, release("v0.29.0")]));
    let result = history.finish(true, None);
    assert!(!result.complete);
    assert_eq!(result.reason.as_deref(), Some("updates.historyLimit"));
    assert!(
        result
            .entries
            .iter()
            .filter_map(|entry| entry.notes.as_ref())
            .map(String::len)
            .sum::<usize>()
            <= MAX_NOTES
    );

    let mut history = builder("beta");
    history.add(batch(
        (1..=MAX_ENTRIES + 1)
            .map(|n| release(&format!("v0.28.0-beta.{n}")))
            .collect(),
    ));
    history.add(batch(vec![release("v0.29.0")]));
    let result = history.finish(true, None);
    assert_eq!(result.entries.len(), MAX_ENTRIES);
    assert_eq!(result.entries[0].version, "0.29.0");
    assert!(!result.complete);
}

#[test]
fn invalid_or_downgrade_ranges_are_rejected() {
    let settings = Settings::default();
    for (current, target) in [
        ("bad", "0.29.0"),
        ("0.29.0", "0.29.0"),
        ("0.29.1", "0.29.0"),
        ("0.28.0", "0.29.0-beta.1"),
    ] {
        let mut snapshot = UpdateState::new(current.into(), &settings);
        snapshot.version = Some(target.into());
        assert!(HistoryBuilder::new(&snapshot).is_err());
    }
}

async fn server(responses: Vec<(u64, String)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/?per_page=100", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (delay, response) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let size = stream.read(&mut bytes).await.unwrap();
            requests.push(String::from_utf8_lossy(&bytes[..size]).into_owned());
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let _ = stream.write_all(response.as_bytes()).await;
        }
        requests
    });
    (endpoint, task)
}

fn response(status: &str, body: &str, more: bool) -> String {
    let link = if more {
        "Link: <https://untrusted.example/secret>; rel=\"next\"\r\n"
    } else {
        ""
    };
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{link}Connection: close\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn reads_every_page_instead_of_stopping_at_an_old_or_target_version() {
    let (endpoint, task) = server(vec![
        (
            0,
            response("200 OK", &json!([release("v0.26.0")]).to_string(), true),
        ),
        (
            0,
            response("200 OK", &json!([release("v0.29.0")]).to_string(), true),
        ),
        (
            0,
            response("200 OK", &json!([release("v0.28.0")]).to_string(), false),
        ),
    ])
    .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = fetch(
        &client,
        &endpoint,
        builder("stable"),
        Duration::from_secs(5),
    )
    .await;
    assert!(result.complete);
    assert_eq!(result.entries.len(), 2);
    let requests = task.await.unwrap();
    for (index, request) in requests.iter().enumerate() {
        assert!(request.starts_with(&format!("GET /?per_page=100&page={} HTTP/1.1", index + 1)));
    }
}

#[tokio::test]
async fn failures_keep_previous_pages_and_target_notes_without_marking_them_complete() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (status, body) in [("429 Too Many Requests", "quota"), ("200 OK", "bad json")] {
        let (endpoint, task) = server(vec![
            (
                0,
                response("200 OK", &json!([release("v0.28.0")]).to_string(), true),
            ),
            (0, response(status, body, false)),
        ])
        .await;
        let result = fetch(
            &client,
            &endpoint,
            builder("stable"),
            Duration::from_secs(5),
        )
        .await;
        assert!(!result.complete);
        assert_eq!(result.reason.as_deref(), Some("updates.historyUnavailable"));
        assert_eq!(result.entries.len(), 2);
        assert_eq!(
            result.entries[0].notes.as_deref(),
            Some("Selected target notes")
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn bounded_deadline_returns_partial_history_instead_of_losing_it() {
    let (endpoint, task) = server(vec![
        (
            0,
            response("200 OK", &json!([release("v0.28.0")]).to_string(), true),
        ),
        (
            1000,
            response("200 OK", &json!([release("v0.29.0")]).to_string(), false),
        ),
    ])
    .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = fetch(
        &client,
        &endpoint,
        builder("stable"),
        Duration::from_millis(100),
    )
    .await;
    assert!(!result.complete);
    assert_eq!(result.entries.len(), 2);
    assert_eq!(result.reason.as_deref(), Some("updates.historyUnavailable"));
    task.abort();
}

#[tokio::test]
async fn pagination_limit_is_explicit_even_if_target_was_found() {
    let body = json!([release("v0.29.0")]).to_string();
    let (endpoint, task) = server(
        (0..MAX_PAGES)
            .map(|_| (0, response("200 OK", &body, true)))
            .collect(),
    )
    .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = fetch(
        &client,
        &endpoint,
        builder("stable"),
        Duration::from_secs(5),
    )
    .await;
    assert!(!result.complete);
    assert_eq!(result.reason.as_deref(), Some("updates.historyLimit"));
    assert_eq!(task.await.unwrap().len(), MAX_PAGES);
}

#[tokio::test]
#[ignore = "requires live GitHub and an explicitly selected test route"]
async fn live_history_through_selected_route() {
    let route = std::env::var("TUNNELDE_UPDATE_TEST_PROXY").expect("explicit proxy URL or direct");
    let mut client = reqwest::Client::builder().no_proxy();
    if route != "direct" {
        client = client.proxy(reqwest::Proxy::all(route).unwrap());
    }
    let client = client
        .user_agent("Tunnelde-history-regression")
        .build()
        .unwrap();
    let settings = Settings {
        update_channel: "beta".into(),
        ..Settings::default()
    };
    let mut snapshot = UpdateState::new("0.27.1".into(), &settings);
    snapshot.version = Some("0.29.0-beta.1".into());
    let result = fetch(
        &client,
        RELEASES_API,
        HistoryBuilder::new(&snapshot).unwrap(),
        Duration::from_secs(25),
    )
    .await;
    assert!(result.complete, "{:?}", result.reason);
    assert!(result.entries.iter().any(|entry| entry.version == "0.28.0"));
    assert_eq!(result.entries[0].version, "0.29.0-beta.1");
    assert!(result
        .entries
        .iter()
        .all(|entry| entry.notes.as_ref().is_some_and(|notes| !notes.is_empty())));
    println!(
        "{} release notes, {} -> {}",
        result.entries.len(),
        result.current_version,
        result.version
    );
}
