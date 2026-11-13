use crate::automation::contract::Failure;
use crate::services::forwarding::contract::RevisionedInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const MAX_PAGE_BYTES: usize = 64 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    #[serde(default)]
    pub after: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    50
}
fn token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
pub(super) fn parse(params: Value) -> Result<Request, Failure> {
    let invalid = || {
        Failure::new(
            "invalid_request",
            "Invalid forwarding parameters; check the forwards.list input schema in api.describe",
        )
    };
    let request: Request = serde_json::from_value(params).map_err(|_| invalid())?;
    if !(1..=128).contains(&request.limit) || (!request.after.is_empty() && !token(&request.after))
    {
        return Err(invalid());
    }
    Ok(request)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    host_id: String,
    name: String,
    revision: String,
    direction: Direction,
    bind: Endpoint,
    target: Endpoint,
    state: State,
}
#[derive(Serialize)]
struct Endpoint {
    host: String,
    port: u16,
}
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Local,
    Remote,
}
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Running,
    Stopped,
}
pub(super) fn page(records: Vec<RevisionedInfo>, limit: usize) -> Result<Value, Failure> {
    let mut entries = Vec::new();
    let total = records.len();
    // Reserve enough space for page keys, commas and the escaped continuation.
    let mut bytes = 1024;
    for record in records.into_iter().take(limit) {
        let rule = record.info.rule;
        if !token(&rule.id) || !token(&rule.host_id) || !token(&record.revision) {
            return Err(Failure::new(
                "operation_rejected",
                "Stored forwarding rule is invalid; inspect application logs",
            ));
        }
        let entry = Entry {
            id: rule.id,
            host_id: rule.host_id,
            name: rule.name,
            revision: record.revision,
            direction: match rule.mode.as_str() {
                "local" => Direction::Local,
                "remote" => Direction::Remote,
                _ => {
                    return Err(Failure::new(
                        "operation_rejected",
                        "Stored forwarding direction is invalid",
                    ))
                }
            },
            bind: Endpoint {
                host: rule.bind_host,
                port: rule.bind_port,
            },
            target: Endpoint {
                host: rule.target_host,
                port: rule.target_port,
            },
            state: if record.info.active {
                State::Running
            } else {
                State::Stopped
            },
        };
        let value = serde_json::to_value(entry)
            .map_err(|_| Failure::new("internal", "Cannot encode a forwarding entry"))?;
        let size = serde_json::to_vec(&value)
            .map_err(|_| Failure::new("internal", "Cannot encode a forwarding entry"))?
            .len()
            + 1;
        if bytes + size > MAX_PAGE_BYTES {
            break;
        }
        bytes += size;
        entries.push(value);
    }
    if total > 0 && entries.is_empty() {
        return Err(Failure::new(
            "operation_rejected",
            "Stored forwarding entry exceeds the page budget",
        ));
    }
    let next = (entries.len() < total).then(|| entries.last().unwrap()["id"].clone());
    Ok(serde_json::json!({"entries":entries,"nextAfter":next}))
}
