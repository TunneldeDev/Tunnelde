use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const VERSION: u8 = 1;
pub(super) const MAX_REQUEST: usize = 32 * 1024;
pub(super) const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub version: u8,
    pub id: String,
    pub token: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Failure {
    pub code: String,
    pub message: String,
}
impl Failure {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn exit_code(&self) -> i32 {
        match self.code.as_str() {
            "invalid_arguments"
            | "invalid_request"
            | "invalid_response"
            | "unknown_method"
            | "unsupported_version"
            | "invalid_preferences" => 2,
            "stale_revision" => 5,
            "unavailable" | "timeout" => 3,
            "unauthorized" => 4,
            _ => 1,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(try_from = "serde_json::Map<String, Value>")]
pub(super) struct Response {
    pub version: u8,
    pub id: String,
    #[serde(flatten)]
    pub outcome: Outcome,
}
impl TryFrom<serde_json::Map<String, Value>> for Response {
    type Error = &'static str;
    fn try_from(mut fields: serde_json::Map<String, Value>) -> Result<Self, Self::Error> {
        let version = fields
            .remove("version")
            .and_then(|value| value.as_u64())
            .and_then(|value| u8::try_from(value).ok())
            .ok_or("invalid response version")?;
        let id = fields
            .remove("id")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or("invalid response id")?;
        let result = fields.remove("result");
        let error = fields.remove("error");
        let outcome = match (result, error) {
            (Some(result), None) => Outcome::Success { result },
            (None, Some(error)) => Outcome::Error {
                error: serde_json::from_value(error).map_err(|_| "invalid response error")?,
            },
            _ => return Err("expected exactly one result or error"),
        };
        // Output metadata is additive. Required fields and the mutually
        // exclusive outcome remain checked before ignoring unknown fields.
        Ok(Self {
            version,
            id,
            outcome,
        })
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Outcome {
    Success { result: Value },
    Error { error: Failure },
}
impl Response {
    pub fn new(id: String, result: Result<Value, Failure>) -> Self {
        Self {
            version: VERSION,
            id,
            outcome: match result {
                Ok(result) => Outcome::Success { result },
                Err(error) => Outcome::Error { error },
            },
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Endpoint {
    pub version: u8,
    pub address: std::net::SocketAddr,
    pub token: String,
}

pub(super) fn describe() -> Value {
    let mut schema: Value =
        serde_json::from_str(include_str!("schema/v1.json")).expect("checked local API schema");
    schema["methods"]
        .as_array_mut()
        .expect("core methods")
        .extend(super::domains::additional_contracts());
    schema["protocol"] = serde_json::from_str(include_str!("schema/protocol-v1.json"))
        .expect("checked local protocol schema");
    schema["methods"]
        .as_array_mut()
        .expect("core methods")
        .iter_mut()
        .find(|method| method["name"] == "api.describe")
        .expect("discovery method")["resultSchema"] =
        serde_json::from_str(include_str!("schema/discovery-v1.json"))
            .expect("checked local discovery schema");
    schema
}

pub(super) fn validate(request: &Request, token: &str) -> Result<(), Failure> {
    // Fixed length avoids accepting malformed capabilities. Never echo the token.
    if request.token.len() != 64 || token.len() != 64 || !equal(&request.token, token) {
        return Err(Failure::new(
            "unauthorized",
            "Local API authentication failed",
        ));
    }
    if request.version != VERSION {
        return Err(Failure::new(
            "unsupported_version",
            "Unsupported local API protocol version",
        ));
    }
    if request.id.is_empty() || request.id.len() > 128 || request.id.chars().any(char::is_control) {
        return Err(Failure::new(
            "invalid_request",
            "Request id must contain 1 to 128 non-control bytes",
        ));
    }
    if !request.params.is_object() {
        return Err(Failure::new("invalid_request", "params must be an object"));
    }
    if request.method.is_empty()
        || request.method.len() > 128
        || !request
            .method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._".contains(&byte))
    {
        return Err(Failure::new(
            "invalid_request",
            "Invalid local API method name",
        ));
    }
    Ok(())
}

fn equal(left: &str, right: &str) -> bool {
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
