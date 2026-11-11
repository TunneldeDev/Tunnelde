use super::contracts::{identifier, Entry};
use chrono::Datelike;
use serde_json::{Map, Value};

fn timestamp(value: &str) -> bool {
    value.len() <= 64
        && chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|date| {
            (0..=9999).contains(&date.year()) && date.timestamp_subsec_nanos() < 1_000_000_000
        })
}

fn text(value: &str, limit: usize) -> (String, bool) {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (
        value[..end]
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect(),
        end < value.len(),
    )
}
fn safe_numbers(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_some_and(|v| {
            v.is_finite() && (v.fract() != 0.0 || v.abs() <= super::contracts::MAX_SAFE as f64)
        }),
        Value::Object(v) => v.values().all(safe_numbers),
        Value::Array(v) => v.iter().all(safe_numbers),
        _ => true,
    }
}
pub fn diagnostic(bytes: &[u8]) -> Option<Entry> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let record = value.as_object()?;
    let fields = record.get("fields").and_then(Value::as_object);
    let get = |key: &str| fields.and_then(|v| v.get(key)).or_else(|| record.get(key));
    let raw_message = get("message")?.as_str()?;
    let (message, mut truncated) = text(raw_message, 16 * 1024);
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .filter(|v| timestamp(v))
        .map(str::to_owned);
    let plugin_id = get("plugin_id")
        .and_then(Value::as_str)
        .filter(|v| identifier(v, 128))
        .map(str::to_owned);
    let raw_domain = get("domain")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            record
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or("application")
                .trim_start_matches("tunnelde_lib")
                .trim_start_matches("::")
                .replace("::", ".")
        });
    let domain = if identifier(&raw_domain, 256) {
        raw_domain
    } else {
        "application".into()
    };
    let level = record
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("info")
        .to_ascii_lowercase();
    if !["trace", "debug", "info", "warn", "error"].contains(&level.as_str()) {
        return None;
    }
    let mut context = fields.cloned().unwrap_or_default();
    for key in ["message", "domain", "plugin_id", "plugin", "level"] {
        context.remove(key);
    }
    if let Some(encoded) = context.remove("context") {
        match encoded
            .as_str()
            .filter(|v| v.len() <= 16 * 1024)
            .and_then(|v| serde_json::from_str::<Map<String, Value>>(v).ok())
        {
            Some(parsed) => {
                context.insert("context".into(), Value::Object(parsed));
            }
            None => truncated = true,
        }
    }
    let mut fields = Value::Object(context);
    if crate::diagnostics::clean_context(&mut fields).is_err() || !safe_numbers(&fields) {
        fields = Value::Object(Map::new());
        truncated = true;
    }
    let mut entry = Entry {
        timestamp,
        level,
        domain,
        plugin_id,
        message,
        fields,
        truncated,
    };
    // JSON escapes can expand bounded text; keep every single record below 64KiB.
    if serde_json::to_vec(&entry).ok()?.len() > 64 * 1024 {
        entry.message = text(&entry.message, 4096).0;
        entry.fields = Value::Object(Map::new());
        entry.truncated = true;
    }
    Some(entry)
}

pub fn operation(timestamp: i64, action: String, target: Option<String>) -> Entry {
    let (message, mut truncated) = text(&action, 1024);
    let domain = action
        .split('.')
        .next()
        .filter(|v| identifier(v, 128))
        .unwrap_or("operations")
        .to_owned();
    let plugin_id = action
        .starts_with("plugin.")
        .then(|| target.as_ref().filter(|v| identifier(v, 128)).cloned())
        .flatten();
    let fields = if let Some(target) = target {
        let (target, cut) = text(&target, 1024);
        truncated |= cut;
        serde_json::json!({"target":target})
    } else {
        serde_json::json!({})
    };
    Entry {
        timestamp: chrono::DateTime::from_timestamp_millis(timestamp)
            .filter(|v| (0..=9999).contains(&v.year()))
            .map(|v| v.to_rfc3339()),
        level: "info".into(),
        domain,
        plugin_id,
        message,
        fields,
        truncated,
    }
}
