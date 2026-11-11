//! Independent public log pages, not the native Output/JSONL representation.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_PAGE: usize = 128 * 1024;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    #[default]
    Diagnostics,
    Operations,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub levels: Vec<String>,
    #[serde(default)]
    pub text: String,
}

pub fn identifier(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
}
impl Filter {
    fn validate(&mut self) -> Result<(), &'static str> {
        if self.domains.len() > 16
            || self.plugins.len() > 16
            || self.levels.len() > 5
            || self.text.len() > 256
            || self.text.chars().any(char::is_control)
            || self.domains.iter().any(|v| !identifier(v, 256))
            || self.plugins.iter().any(|v| !identifier(v, 128))
            || self
                .levels
                .iter()
                .any(|v| !["trace", "debug", "info", "warn", "error"].contains(&v.as_str()))
        {
            return Err("invalid log filter");
        }
        for values in [&mut self.domains, &mut self.plugins, &mut self.levels] {
            values.sort();
            if values.windows(2).any(|v| v[0] == v[1]) {
                return Err("duplicate log filter");
            }
        }
        Ok(())
    }
    pub fn matches(&self, entry: &Entry) -> bool {
        (self.domains.is_empty() || self.domains.contains(&entry.domain))
            && (self.plugins.is_empty()
                || entry
                    .plugin_id
                    .as_ref()
                    .is_some_and(|id| self.plugins.contains(id)))
            && (self.levels.is_empty() || self.levels.contains(&entry.level))
            && (self.text.is_empty()
                || format!(
                    "{} {} {} {}",
                    entry.message,
                    entry.domain,
                    entry.plugin_id.as_deref().unwrap_or(""),
                    entry.fields
                )
                .to_lowercase()
                .contains(&self.text.to_lowercase()))
    }
}

#[derive(Deserialize)]
#[serde(try_from = "Map<String, Value>")]
pub struct Request {
    pub source: Source,
    pub cursor: Option<String>,
    pub filter: Filter,
    pub limit: usize,
}
impl TryFrom<Map<String, Value>> for Request {
    type Error = &'static str;
    fn try_from(mut fields: Map<String, Value>) -> Result<Self, Self::Error> {
        fn take<T: DeserializeOwned>(
            fields: &mut Map<String, Value>,
            name: &str,
        ) -> Result<Option<T>, &'static str> {
            fields
                .remove(name)
                .map(|v| serde_json::from_value(v).map_err(|_| "invalid log request"))
                .transpose()
        }
        let source = take(&mut fields, "source")?.unwrap_or_default();
        let cursor: Option<String> = take(&mut fields, "cursor")?;
        let mut filter: Filter = take(&mut fields, "filter")?.unwrap_or_default();
        let limit = take(&mut fields, "limit")?.unwrap_or(100);
        if !fields.is_empty()
            || !(1..=200).contains(&limit)
            || cursor.as_ref().is_some_and(|v| {
                v.is_empty()
                    || v.len() > 2048
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
        {
            return Err("invalid log request");
        }
        filter.validate()?;
        Ok(Self {
            source,
            cursor,
            filter,
            limit,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub timestamp: Option<String>,
    pub level: String,
    pub domain: String,
    pub plugin_id: Option<String>,
    pub message: String,
    pub fields: Value,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub version: u8,
    pub source: Source,
    pub entries: Vec<Entry>,
    pub cursor: String,
    pub has_more: bool,
    pub reset: bool,
    pub gap: bool,
}

pub struct Batch {
    pub entries: Vec<Entry>,
    pub bytes: usize,
    pub gap: bool,
}
impl Batch {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            bytes: 4096,
            gap: false,
        }
    }
    pub fn push(&mut self, entry: Entry, request: &Request) -> bool {
        let size = serde_json::to_vec(&entry).map_or(MAX_PAGE, |v| v.len() + 1);
        if self.entries.len() >= request.limit || self.bytes + size > MAX_PAGE {
            return false;
        }
        self.bytes += size;
        self.entries.push(entry);
        true
    }
}
