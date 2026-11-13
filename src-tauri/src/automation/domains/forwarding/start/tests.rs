use super::*;
use serde_json::json;
pub(in super::super) fn samples() -> Vec<Value> {
    let input = json!({"id":"rule", "revision":"revision", "requestId":"12345678-1234-1234-1234-123456789abc"});
    let request = parse(input.clone()).unwrap();
    let result = serde_json::to_value(start::receipt::Receipt {
        input: request,
        phase: start::receipt::Phase::Consent,
        expires_at: 1_800_000_000_000,
        error: None,
    })
    .unwrap();
    vec![
        json!({"method":"forwards.start","params":input,"result":result}),
        json!({"method":"forwards.startStatus","params":{"requestId":input["requestId"]},"result":result}),
        json!({"method":"forwards.cancelStart","params":{"requestId":input["requestId"]},"result":result}),
    ]
}
#[test]
fn input_rejects_private_fields_ambiguous_ids_and_unbounded_tokens() {
    let valid =
        json!({"id":"rule", "revision":"rev", "requestId":"12345678-1234-1234-1234-123456789abc"});
    assert!(parse(valid.clone()).is_ok());
    for field in ["password", "sessionId", "trust", "scope", "review", "uiId"] {
        let mut value = valid.clone();
        value[field] = json!("private");
        assert!(parse(value).is_err());
    }
    for id in [
        "12345678-1234-1234-1234-123456789ABC",
        "invalid",
        "{12345678-1234-1234-1234-123456789abc}",
    ] {
        let mut value = valid.clone();
        value["requestId"] = json!(id);
        assert!(parse(value).is_err());
    }
    for token in ["", "x\n", "\u{202e}", &"界".repeat(43)] {
        let mut value = valid.clone();
        value["revision"] = json!(token);
        assert!(parse(value).is_err());
    }
    assert!(query(json!({"requestId":valid["requestId"],"id":"unexpected"})).is_err());
}
