use super::*;
use serde_json::json;
use tracing_subscriber::prelude::*;

fn entry(value: Value) -> LogEntry {
    serde_json::from_value(value).unwrap()
}

#[test]
fn legacy_and_structured_entries_validate_and_cannot_override_identity() {
    let value =
        entry(json!({"message":"hello", "level":"ERROR", "plugin_id":"other", "generation":999}));
    let prepared = prepare(
        &LogOrigin::Plugin {
            id: "actual",
            generation: 7,
        },
        value,
    )
    .unwrap();
    assert_eq!(prepared.domain, "plugins.actual.application");
    assert!(matches!(prepared.entry.level, LogLevel::Error));
    let prepared = prepare(
        &LogOrigin::Frontend,
        entry(json!({"message":"hello", "domain":"ssh"})),
    )
    .unwrap();
    assert_eq!(prepared.domain, "frontend.ssh");
    assert!(matches!(
        entry(json!({"message":"legacy"})).level,
        LogLevel::Info
    ));
    assert!(serde_json::from_value::<LogEntry>(json!({"message":"bad", "level":"fatal"})).is_err());
    assert!(serde_json::from_value::<LogEntry>(json!({"message":"bad", "fields":[]})).is_err());
}

#[test]
fn structured_context_redacts_nested_credentials_and_url_secrets() {
    let prepared = prepare(&LogOrigin::Native, entry(json!({
        "message":"failed\nforged", "fields": {
            "password":"secret", "nested":[{"api_key":"key", "accessToken":"token", "status":403}],
            "url":"https://user:pass@example.com/path?token=abc#secret", "attempt":2
        }
    }))).unwrap();
    assert_eq!(prepared.entry.message, "failed forged");
    assert_eq!(
        prepared.context,
        json!({
            "password":"[REDACTED]", "nested":[{"api_key":"[REDACTED]", "accessToken":"[REDACTED]", "status":403}],
            "url":"https://example.com/path", "attempt":2
        })
    );
}

#[test]
fn rejects_oversized_deep_or_forged_routing_parameters_before_emitting() {
    for value in [
        json!({"message":"x".repeat(MAX_MESSAGE + 1)}),
        json!({"message":"ok", "domain":"../other"}),
        json!({"message":"ok", "requestId":"a\nb"}),
        json!({"message":"ok", "fields":{"a":"x".repeat(MAX_FIELDS)}}),
        json!({"message":"ok", "fields":{"a":[[[[[1]]]]]}}),
        json!({"message":"ok", "fields":{"a":vec![0; MAX_NODES]}}),
    ] {
        assert!(prepare(&LogOrigin::Native, entry(value)).is_err());
    }
}

#[test]
fn writes_requested_severity_to_local_json_and_honors_filter() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-diagnostics-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("test.log");
    let file = std::fs::File::create(&path).unwrap();
    let (writer, guard) = tracing_appender::non_blocking(file);
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_writer(writer)
            .with_filter(tracing_subscriber::filter::LevelFilter::WARN),
    );
    tracing::subscriber::with_default(subscriber, || {
        for level in ["trace", "debug", "info", "warn", "error"] {
            write(
                LogOrigin::Plugin {
                    id: "actual",
                    generation: 7,
                },
                entry(json!({
                    "message":"connection failed", "level":level, "domain":"connection",
                    "operation":"connect", "requestId":"request-123", "fields":{"status":403}
                })),
            )
            .unwrap();
        }
    });
    drop(guard);
    let text = std::fs::read_to_string(path).unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["level"], "WARN");
    assert_eq!(rows[1]["level"], "ERROR");
    for row in rows {
        assert_eq!(row["fields"]["domain"], "plugins.actual.connection");
        assert_eq!(row["fields"]["plugin_id"], "actual");
        assert_eq!(row["fields"]["generation"], 7);
        assert_eq!(row["fields"]["request_id"], "request-123");
        assert_eq!(row["fields"]["operation"], "connect");
        assert_eq!(row["fields"]["context"], r#"{"status":403}"#);
    }
    std::fs::remove_dir_all(directory).unwrap();
}
