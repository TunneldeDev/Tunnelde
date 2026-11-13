//! Versioned wire envelopes. Internal Settings and persistence keys are private.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A conditional read, not a durable event cursor. Tokens are opaque and bounded.
#[derive(Default, Deserialize)]
#[serde(try_from = "serde_json::Map<String, Value>")]
pub(crate) struct Observe {
    pub revision: Option<String>,
}

impl TryFrom<serde_json::Map<String, Value>> for Observe {
    type Error = &'static str;

    fn try_from(mut fields: serde_json::Map<String, Value>) -> Result<Self, Self::Error> {
        let revision = match fields.remove("revision") {
            None => None,
            Some(Value::String(revision))
                if !revision.is_empty()
                    && revision.len() <= 128
                    && !revision.chars().any(char::is_control) =>
            {
                Some(revision)
            }
            Some(_) => return Err("invalid preference revision"),
        };
        if !fields.is_empty() {
            return Err("unknown preference observation field");
        }
        Ok(Self { revision })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub version: u8,
    pub revision: String,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub values: Value,
    pub defaults: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schema {
    pub version: u8,
    pub stability: &'static str,
    pub groups: Value,
}

#[derive(Deserialize)]
#[serde(try_from = "serde_json::Map<String, Value>")]
pub(crate) struct Update {
    pub revision: String,
    pub changes: Value,
}

impl TryFrom<serde_json::Map<String, Value>> for Update {
    type Error = &'static str;
    fn try_from(mut fields: serde_json::Map<String, Value>) -> Result<Self, Self::Error> {
        let revision = fields
            .remove("revision")
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| {
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
            })
            .ok_or("invalid preference revision")?;
        let changes = fields
            .remove("changes")
            .filter(Value::is_object)
            .ok_or("expected preference changes object")?;
        if !fields.is_empty() {
            return Err("unknown preference update field");
        }
        Ok(Self { revision, changes })
    }
}
