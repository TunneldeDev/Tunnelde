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
    for method in methods {
        assert!(["read", "write"].contains(&method["effect"].as_str().unwrap()));
        assert_eq!(method["inputSchema"]["additionalProperties"], false);
        assert_eq!(method["resultSchema"]["type"], "object");
    }
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
    .is_err());
    assert!(
        serde_json::from_value::<Response>(json!({"version":1,"id":"r","result":null})).is_ok()
    );
}
