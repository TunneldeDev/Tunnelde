//! Standalone JSON data contract, separate from host paths and keyring secrets.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Default, Deserialize)]
#[serde(try_from = "Map<String, Value>")]
pub(in crate::plugins::api::domains::storage) struct Observe {
    pub revision: Option<String>,
}
impl TryFrom<Map<String, Value>> for Observe {
    type Error = &'static str;
    fn try_from(mut fields: Map<String, Value>) -> Result<Self, Self::Error> {
        let revision = match fields.remove("revision") {
            None => None,
            Some(Value::String(value))
                if !value.is_empty()
                    && value.len() <= 128
                    && !value.chars().any(char::is_control) =>
            {
                Some(value)
            }
            Some(_) => return Err("invalid storage revision"),
        };
        if !fields.is_empty() {
            return Err("unknown storage observation field");
        }
        Ok(Self { revision })
    }
}
#[derive(Serialize)]
pub(super) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub values: Map<String, Value>,
}
#[derive(Serialize)]
pub(super) struct Observation {
    pub version: u8,
    pub revision: String,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
}
