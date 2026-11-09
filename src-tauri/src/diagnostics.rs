//! Shared, bounded logging for native features, the frontend and plugin runtimes.
//! Identity comes from the caller's trusted adapter, never from payload fields.
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

const MAX_MESSAGE: usize = 16 * 1024;
const MAX_FIELDS: usize = 16 * 1024;
const MAX_NODES: usize = 256;

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    #[serde(alias = "TRACE")]
    Trace,
    #[serde(alias = "DEBUG")]
    Debug,
    #[default]
    #[serde(alias = "INFO")]
    Info,
    #[serde(alias = "warning", alias = "WARN", alias = "WARNING")]
    Warn,
    #[serde(alias = "ERROR")]
    Error,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub message: String,
    #[serde(default)]
    pub level: LogLevel,
    pub domain: Option<String>,
    pub operation: Option<String>,
    pub request_id: Option<String>,
    #[serde(default)]
    pub fields: Map<String, Value>,
}

pub enum LogOrigin<'a> {
    Native,
    Frontend,
    Plugin { id: &'a str, generation: u64 },
}

fn invalid(field: &str) -> AppError {
    AppError::validation(format!("logs.invalid:{field}"))
}

fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
}

fn plain(text: &str) -> String {
    // A log message is one event, not additional forged log lines or terminal controls.
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

fn sensitive(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "authorization",
        "cookie",
        "privatekey",
        "credential",
        "apikey",
        "proxyurl",
    ]
    .iter()
    .any(|part| key.contains(part))
}

fn clean(value: &mut Value, depth: usize, nodes: &mut usize) -> AppResult<()> {
    *nodes += 1;
    if depth > 4 || *nodes > MAX_NODES {
        return Err(invalid("fields"));
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if !identifier(key, 64) {
                    return Err(invalid("fields"));
                }
                if sensitive(key) {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    clean(value, depth + 1, nodes)?;
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                clean(value, depth + 1, nodes)?;
            }
        }
        Value::String(text) => {
            // Only structured URL values are sanitized; arbitrary free text must not
            // contain secrets. Do not pretend to detect every credential in prose.
            if let Ok(mut url) = reqwest::Url::parse(text) {
                if matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    *text = url.to_string();
                }
            }
            *text = plain(text);
        }
        _ => {}
    }
    Ok(())
}

struct Prepared {
    entry: LogEntry,
    domain: String,
    context: Value,
}

fn prepare(origin: &LogOrigin<'_>, mut entry: LogEntry) -> AppResult<Prepared> {
    if entry.message.len() > MAX_MESSAGE {
        return Err(invalid("message"));
    }
    for (name, value) in [
        ("domain", &entry.domain),
        ("operation", &entry.operation),
        ("requestId", &entry.request_id),
    ] {
        if value
            .as_deref()
            .is_some_and(|value| !identifier(value, 128))
        {
            return Err(invalid(name));
        }
    }
    if serde_json::to_vec(&entry.fields)?.len() > MAX_FIELDS {
        return Err(invalid("fields"));
    }
    let mut context = Value::Object(std::mem::take(&mut entry.fields));
    clean(&mut context, 0, &mut 0)?;
    entry.message = plain(&entry.message);
    let suffix = entry.domain.as_deref().unwrap_or("application");
    let domain = match origin {
        LogOrigin::Native => suffix.into(),
        LogOrigin::Frontend => format!("frontend.{suffix}"),
        LogOrigin::Plugin { id, .. } => format!("plugins.{id}.{suffix}"),
    };
    Ok(Prepared {
        entry,
        domain,
        context,
    })
}

/// Accepted events use the application's existing filter, local writer and rotation.
/// `fields` is encoded as JSON inside `context` to preserve nested values with tracing.
/// Success means accepted for logging, not fsync or a bypass of the configured filter.
pub fn write(origin: LogOrigin<'_>, entry: LogEntry) -> AppResult<()> {
    let prepared = prepare(&origin, entry)?;
    let (source, plugin_id, generation) = match origin {
        LogOrigin::Native => ("native", None, None),
        LogOrigin::Frontend => ("frontend", None, None),
        LogOrigin::Plugin { id, generation } => ("plugin", Some(id), Some(generation)),
    };
    let entry = prepared.entry;
    macro_rules! emit {
        ($level:expr) => {
            tracing::event!(target: "tunnelde_lib::diagnostics", $level,
                source, domain = %prepared.domain, plugin_id, generation,
                operation = entry.operation.as_deref(), request_id = entry.request_id.as_deref(),
                context = %prepared.context, message = %entry.message)
        };
    }
    match entry.level {
        LogLevel::Trace => emit!(tracing::Level::TRACE),
        LogLevel::Debug => emit!(tracing::Level::DEBUG),
        LogLevel::Info => emit!(tracing::Level::INFO),
        LogLevel::Warn => emit!(tracing::Level::WARN),
        LogLevel::Error => emit!(tracing::Level::ERROR),
    }
    Ok(())
}

#[tauri::command]
pub fn logs_write(entry: LogEntry) -> AppResult<()> {
    write(LogOrigin::Frontend, entry)
}

#[cfg(test)]
mod tests;
