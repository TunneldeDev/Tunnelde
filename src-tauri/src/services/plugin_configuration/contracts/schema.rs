use super::migration::Migration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Declaration {
    pub version: u32,
    pub groups: Vec<Group>,
    pub fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub migrations: Vec<Migration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub id: String,
    pub group: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub schema: ValueSchema,
    pub default: Value,
}

/// Deliberately bounded JSON Schema subset; unsupported keywords fail deserialization.
/// Required bounds make both rendering and validation predictable across runtimes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum ValueSchema {
    String {
        #[serde(rename = "maxLength")]
        max_length: u32,
        #[serde(default, rename = "minLength", skip_serializing_if = "Option::is_none")]
        min_length: Option<u32>,
        #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
        choices: Option<Vec<String>>,
    },
    Boolean {},
    Number {
        minimum: f64,
        maximum: f64,
    },
    Integer {
        minimum: i64,
        maximum: i64,
    },
    Array {
        items: Box<ValueSchema>,
        #[serde(rename = "maxItems")]
        max_items: u32,
    },
    Object {
        properties: BTreeMap<String, ValueSchema>,
        required: Vec<String>,
        #[serde(rename = "additionalProperties")]
        additional_properties: bool,
    },
}
