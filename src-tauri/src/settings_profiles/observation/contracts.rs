//! Public metadata only. Portable settings and private persistence keys stay internal.
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
            Some(Value::String(value))
                if !value.is_empty()
                    && value.len() <= 128
                    && !value.chars().any(char::is_control) =>
            {
                Some(value)
            }
            Some(_) => return Err("invalid profile revision"),
        };
        if !fields.is_empty() {
            return Err("unknown profile observation field");
        }
        Ok(Self { revision })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    pub id: String,
    pub name: String,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub items: Vec<Metadata>,
}

#[derive(Serialize)]
pub(crate) struct Observation {
    pub version: u8,
    pub revision: String,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
}
