use super::*;
use serde_json::json;
use tracing_subscriber::prelude::*;

pub(in crate::plugins) fn contract_samples() -> Vec<Value> {
    let mut samples = Vec::new();
    let mut accepted = vec![
        json!({"message":""}),
        json!({"message":"你好\nnext", "future":true}),
        json!({"message":"ok", "domain":null,"operation":null,"requestId":null}),
        json!({"message":"ok", "domain":"a".repeat(128),"operation":"A-z_1.:"}),
        json!({"message":"x".repeat(16384)}),
        json!({"message":"文".repeat(5461)}),
        json!({"message":"ok", "fields":{"a":{"b":{"c":{"d":1}}}}}),
        json!({"message":"ok", "fields":{"a":vec![0;254]}}),
        // Sensitive values are replaced before traversal; their nested shape is
        // intentionally not part of the structural field schema.
        json!({"message":"ok", "fields":{"password":{"bad/key":[[[[[1]]]]]}}}),
        json!({"message":"ok", "fields":{"a".repeat(64):"x".repeat(16313)}}),
        json!({"message":"ok", "domain":"connection","operation":"connect", "requestId":"req-1",
            "fields":{"status":403,"nested":[true,null,"你好"],"url":"https://u:p@example.test/a?key=s#s"},
            "plugin_id":"forged", "generation":999}),
    ];
    for level in [
        "trace", "debug", "info", "warn", "error", "TRACE", "DEBUG", "INFO", "WARN", "ERROR",
        "warning", "WARNING",
    ] {
        let params = json!({"message":"legacy", "level":level});
        let result = write("contract-plugin", 7, params.clone()).unwrap();
        assert!(result.is_null());
        samples.push(json!({"method":"log","params":params,"result":result,"legacySdkLog":true}));
    }
    for params in accepted.drain(..) {
        let result = write("contract-plugin", 7, params.clone()).unwrap();
        assert!(result.is_null());
        samples.push(json!({"method":"log","params":params,"result":result}));
    }
    let mut invalid = vec![
        (json!({}), false, "plugin.api.invalid:log"),
        (json!({"message":null}), false, "plugin.api.invalid:log"),
        (json!({"message":2}), false, "plugin.api.invalid:log"),
        (
            json!({"message":"ok","level":null}),
            false,
            "plugin.api.invalid:log",
        ),
        (
            json!({"message":"ok","level":"fatal"}),
            false,
            "plugin.api.invalid:log",
        ),
        (
            json!({"message":"ok","level":"Info"}),
            false,
            "plugin.api.invalid:log",
        ),
        (
            json!({"message":"ok","fields":[]}),
            false,
            "plugin.api.invalid:log",
        ),
        (
            json!({"message":"ok","fields":null}),
            false,
            "plugin.api.invalid:log",
        ),
        (
            json!({"message":"x".repeat(16385)}),
            false,
            "logs.invalid:message",
        ),
        // JSON Schema counts characters; UTF-8 byte limits remain runtime checks.
        (
            json!({"message":"文".repeat(5462)}),
            true,
            "logs.invalid:message",
        ),
        (
            json!({"message":"ok","fields":{"a":"x".repeat(16384)}}),
            true,
            "logs.invalid:fields",
        ),
        (
            json!({"message":"ok","fields":{"a":[[[[1]]]]}}),
            true,
            "logs.invalid:fields",
        ),
        (
            json!({"message":"ok","fields":{"a":vec![0;255]}}),
            true,
            "logs.invalid:fields",
        ),
        (
            json!({"message":"ok","fields":{"a":{"bad/key":1}}}),
            true,
            "logs.invalid:fields",
        ),
        (
            json!({"message":"ok","fields":{"bad/key":1}}),
            false,
            "logs.invalid:fields",
        ),
        (
            json!({"message":"ok","fields":{"a".repeat(65):1}}),
            false,
            "logs.invalid:fields",
        ),
        (Value::Null, false, "plugin.api.invalidParams"),
        (json!([]), false, "plugin.api.invalidParams"),
        (
            json!({"message":"ok","future":"x".repeat(256*1024)}),
            true,
            "plugin.api.invalidParams",
        ),
    ];
    for field in ["domain", "operation", "requestId"] {
        for value in [
            json!(""),
            json!("a\n"),
            json!("路径"),
            json!("a".repeat(129)),
            json!(2),
        ] {
            let mut params = json!({"message":"ok"});
            params[field] = value.clone();
            invalid.push((
                params,
                false,
                if value.is_string() {
                    match field {
                        "domain" => "logs.invalid:domain",
                        "operation" => "logs.invalid:operation",
                        _ => "logs.invalid:requestId",
                    }
                } else {
                    "plugin.api.invalid:log"
                },
            ));
        }
    }
    for (params, input_valid, message) in invalid {
        let error = write("contract-plugin", 7, params.clone()).unwrap_err();
        assert_eq!(error.to_string(), message);
        samples.push(
            json!({"method":"log","params":params,"inputValid":input_valid,
            "error":super::super::host::error_payload(&error)}),
        );
    }
    samples
}

#[test]
fn log_wire_contract_uses_the_actual_validation_and_writer() {
    let samples = contract_samples();
    assert!(samples.len() >= 50);
    let method = super::super::api::method_info("log").unwrap();
    assert_eq!(method.permissions, &["log"]);
    assert_eq!(method.stability, "stable");
    assert_eq!(method.since, Some("0.21.0"));
}

#[test]
fn log_adapter_preserves_severity_identity_and_filtered_acceptance() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-log-contract-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("fixture.log");
    let (writer, guard) = tracing_appender::non_blocking(std::fs::File::create(&path).unwrap());
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_writer(writer)
            .with_filter(tracing_subscriber::filter::LevelFilter::WARN),
    );
    tracing::subscriber::with_default(subscriber, || {
        for level in ["debug", "warning", "ERROR"] {
            assert_eq!(write("actual", 17, json!({"message":"failed\nnext", "level":level,
                "domain":"connection", "operation":"connect", "requestId":"req-1",
                "plugin_id":"other", "generation":999, "source":"native",
                "fields":{"status":403,"api_key":"secret","url":"https://u:p@example.test/a?secret=yes#secret"}})).unwrap(), Value::Null);
        }
        assert!(write(
            "actual",
            17,
            json!({"message":"must not emit", "level":"fatal"})
        )
        .is_err());
    });
    drop(guard);
    let rows: Vec<Value> = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    for (row, level) in rows.iter().zip(["WARN", "ERROR"]) {
        assert_eq!(row["level"], level);
        let fields = &row["fields"];
        assert_eq!(fields["domain"], "plugins.actual.connection");
        assert_eq!(fields["plugin_id"], "actual");
        assert_eq!(fields["generation"], 17);
        assert_eq!(fields["source"], "plugin");
        assert_eq!(fields["message"], "failed next");
        assert_eq!(fields["request_id"], "req-1");
        assert_eq!(fields["operation"], "connect");
        assert_eq!(
            serde_json::from_str::<Value>(fields["context"].as_str().unwrap()).unwrap(),
            json!({"status":403,"api_key":"[REDACTED]","url":"https://example.test/a"})
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
