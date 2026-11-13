use super::contract::*;
use serde_json::json;

#[test]
fn version_authentication_and_input_are_separate_contract_failures() {
    let token = "a".repeat(64);
    let mut request = Request {
        version: 1,
        id: "consumer-1".into(),
        token: token.clone(),
        method: "hosts.list".into(),
        params: json!({}),
    };
    assert!(validate(&request, &token).is_ok());
    request.token = "b".repeat(64);
    assert_eq!(validate(&request, &token).unwrap_err().code, "unauthorized");
    request.token = token.clone();
    request.version = 2;
    assert_eq!(
        validate(&request, &token).unwrap_err().code,
        "unsupported_version"
    );
    request.version = 1;
    request.id = "\n".into();
    assert_eq!(
        validate(&request, &token).unwrap_err().code,
        "invalid_request"
    );
    request.id = "consumer-2".into();
    request.params = json!([]);
    assert_eq!(
        validate(&request, &token).unwrap_err().code,
        "invalid_request"
    );
}

#[test]
fn discovery_has_bounded_versioned_domain_contracts() {
    let schema = describe();
    assert_eq!(schema["version"], VERSION);
    assert_eq!(schema["stability"], "stable");
    assert_eq!(schema["protocol"]["stability"], "stable");
    assert_eq!(schema["transport"]["maximumRequestBytes"], MAX_REQUEST);
    assert_eq!(schema["transport"]["maximumResponseBytes"], MAX_RESPONSE);
    let methods = schema["methods"].as_array().unwrap();
    let names: std::collections::HashSet<_> = methods
        .iter()
        .map(|method| method["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), methods.len());
    assert!(
        names.contains("app.info")
            && names.contains("hosts.list")
            && names.contains("sessions.list")
    );
    for method in methods
        .iter()
        .filter(|method| method["stability"] == "stable")
    {
        assert_eq!(method["stability"], "stable");
        assert_eq!(method["since"], "0.38.0-beta.1");
        assert!(["read", "write"].contains(&method["effect"].as_str().unwrap()));
        assert_eq!(method["inputSchema"]["additionalProperties"], false);
        assert_eq!(method["resultSchema"]["type"], "object");
    }
    assert_eq!(
        methods
            .iter()
            .filter(|method| method["stability"] == "stable")
            .count(),
        7
    );
    let logs = methods
        .iter()
        .find(|method| method["name"] == "logs.read")
        .unwrap();
    assert_eq!(logs["stability"], "experimental");
    assert_eq!(logs["since"], serde_json::Value::Null);
}

#[test]
fn errors_have_programmable_exit_codes() {
    for (code, exit) in [
        ("invalid_request", 2),
        ("unauthorized", 4),
        ("timeout", 3),
        ("unavailable", 3),
        ("internal", 1),
        ("stale_revision", 5),
        ("invalid_preferences", 2),
    ] {
        let failure = Failure::new(code, "description");
        assert_eq!(failure.exit_code(), exit);
        let encoded = serde_json::to_value(Response::new("req".into(), Err(failure))).unwrap();
        assert_eq!(encoded["error"]["code"], code);
        assert!(encoded.get("result").is_none());
    }
}

#[test]
fn response_cannot_hide_an_error_behind_a_success_field() {
    assert!(serde_json::from_value::<Response>(
        json!({"version":1,"id":"r","result":{},"error":{"code":"internal","message":"failed"}})
    )
    .is_err());
    assert!(serde_json::from_value::<Response>(json!({"version":1,"id":"r"})).is_err());
    assert!(serde_json::from_value::<Response>(
        json!({"version":1,"id":"r","result":{},"extra":true})
    )
    .is_ok());
    assert!(
        serde_json::from_value::<Response>(json!({"version":1,"id":"r","result":null})).is_ok()
    );
}

#[test]
fn additive_outputs_preserve_required_types_and_requests_remain_strict() {
    let response: Response = serde_json::from_value(json!({
        "version":1,"id":"r","metadata":{"future":true},
        "error":{"code":"future_error","message":"description","retryAfter":1}
    }))
    .unwrap();
    assert!(
        matches!(response.outcome, Outcome::Error { error } if error.code == "future_error" && error.exit_code() == 1)
    );
    for invalid in [
        json!({"version":"1","id":"r","result":{}}),
        json!({"version":1,"id":1,"result":{}}),
        json!({"version":1,"id":"r","error":null}),
        json!({"version":1,"id":"r","error":{"code":"internal"}}),
        json!({"version":1,"id":"r","error":{"code":1,"message":"failed"}}),
    ] {
        assert!(serde_json::from_value::<Response>(invalid).is_err());
    }
    assert!(serde_json::from_value::<Request>(json!({
        "version":1,"id":"r","token":"a".repeat(64),"method":"app.info","params":{},"future":true
    }))
    .is_err());
}

#[test]
fn unicode_revision_byte_bound_is_shared_with_the_native_preferences_writer() {
    use crate::services::settings::preferences::contracts::Update;
    assert!(
        serde_json::from_value::<Update>(json!({"revision":"界".repeat(42),"changes":{}})).is_ok()
    );
    for revision in [
        "界".repeat(43),
        "token\n".into(),
        "\u{85}".into(),
        "".into(),
    ] {
        assert!(
            serde_json::from_value::<Update>(json!({"revision":revision,"changes":{}})).is_err()
        );
    }
    let schema = describe();
    let revision = &schema["methods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|method| method["name"] == "preferences.update")
        .unwrap()["inputSchema"]["properties"]["revision"];
    assert_eq!(revision["x-maxBytes"], 128);
}

#[test]
fn only_exact_interactive_methods_extend_the_authenticated_execution_budget() {
    use std::time::Duration;
    for name in ["forwards.save", "forwards.remove", "forwards.stop"] {
        assert_eq!(execution_budget(name), Duration::from_secs(135));
        assert_eq!(exchange_budget(name), Duration::from_secs(150));
    }
    for name in [
        "preferences.update",
        "forwards.list",
        "forwards.start",
        "forwards.save.extra",
        "forwards.SAVE",
        "unknown",
    ] {
        assert_eq!(execution_budget(name), Duration::from_secs(10));
        assert_eq!(exchange_budget(name), Duration::from_secs(10));
    }
}
