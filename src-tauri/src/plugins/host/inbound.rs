//! Stdio control messages never consume a normal request slot.
use crate::plugins::runtime::requests::Requests;
use serde_json::Value;

pub(super) fn request_key(value: &Value) -> Option<String> {
    let id = value.get("id")?;
    if !(id.is_string() || id.is_number()) {
        return None;
    }
    let key = serde_json::to_string(id).ok()?;
    (key.len() <= 256).then_some(key)
}
pub(super) fn cancellation(value: &Value, requests: &Requests) -> bool {
    if value.get("method").and_then(Value::as_str) != Some("$/cancelRequest")
        || value.get("id").is_some()
    {
        return false;
    }
    if value.get("jsonrpc").and_then(Value::as_str) == Some("2.0") {
        if let Some(params) = value.get("params").and_then(Value::as_object) {
            if params.len() == 1 {
                if let Some(key) = request_key(&Value::Object(params.clone())) {
                    requests.cancel("stdio", &key);
                }
            }
        }
    }
    true
}

#[cfg(test)]
#[path = "inbound/tests.rs"]
mod integration;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn control_is_strict_and_does_not_confuse_numeric_and_string_ids() {
        let requests = Requests::default();
        requests.reserve("stdio", "1").unwrap();
        requests.reserve("stdio", "\"1\"").unwrap();
        for value in [
            json!({"jsonrpc":"1.0","method":"$/cancelRequest","params":{"id":1}}),
            json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":1,"extra":true}}),
        ] {
            assert!(cancellation(&value, &requests));
        }
        assert!(!cancellation(
            &json!({"jsonrpc":"2.0","id":2,"method":"$/cancelRequest","params":{"id":1}}),
            &requests
        ));
        assert!(cancellation(
            &json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":1}}),
            &requests
        ));
        assert!(requests.claim("stdio", "1").is_err());
        assert!(requests.claim("stdio", "\"1\"").is_ok());
        assert!(request_key(&json!({"id":true})).is_none());
        assert!(request_key(&json!({"id":"x".repeat(257)})).is_none());
    }
}
