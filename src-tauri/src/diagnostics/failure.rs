use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::json;
use tauri::Webview;

use super::{identifier, invalid, LogLevel};
use crate::error::{AppError, AppResult};

const RECENT_LIMIT: usize = 100;
static RECENT: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    event_id: String,
    domain: String,
    operation: String,
    level: LogLevel,
    code: String,
    message: String,
    request_id: Option<String>,
    #[serde(default)]
    frames: Vec<String>,
    occurrences: Option<u32>,
    // Use the host clock for the persisted record.
    #[serde(rename = "timestamp")]
    _timestamp: String,
}

fn safe_message(message: &str) -> &str {
    match message {
        "panel.viewState.duplicateKey"
        | "panel.viewState.identityChanged"
        | "panel.viewState.invalid"
        | "panel.viewState.invalidKey"
        | "panel.viewState.tooLarge"
        | "panel.viewState.tooManyFields"
        | "panel.window.viewNotReady"
        | "panel.window.staleOwner"
        | "panel.window.cancelled"
        | "panel.window.moveInProgress"
        | "stale panel owner"
        | "stale view checkpoint"
        | "panel transfer pending"
        | "panel is frozen"
        | "panel interaction in progress"
        | "coordinator required"
        | "panel.viewState.changedDuringCapture"
        | "panel.transfer.pending"
        | "panel.is.frozen"
        | "panel.interaction.in.progress"
        | "panel.coordinator.required"
        | "plugin.frontend.viewUnavailable"
        | "host.name.required"
        | "logs.diagnosticReadFailed"
        | "logs.operationsReadFailed"
        | "fonts.loadFailed"
        | "diagnostics.recovered"
        | "diagnostics.clipboardUnavailable"
        | "terminal.checkpointBusy"
        | "updates.sourcesUnavailable"
        | "Error"
        | "TypeError"
        | "ReferenceError"
        | "RangeError"
        | "SyntaxError"
        | "URIError"
        | "EvalError"
        | "AggregateError"
        | "DOMException"
        | "AbortError" => message,
        _ => "Operation failed",
    }
}

fn safe_frame(frame: &str) -> bool {
    if frame.len() > 240 {
        return false;
    }
    let mut parts = frame.rsplitn(3, ':');
    let coordinate = |part: Option<&str>| {
        part.is_some_and(|s| !s.is_empty() && s.len() <= 7 && s.bytes().all(|b| b.is_ascii_digit()))
    };
    if !coordinate(parts.next()) || !coordinate(parts.next()) {
        return false;
    }
    parts.next().is_some_and(|file| {
        (file.starts_with("src/") || file.starts_with("assets/"))
            && [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs"]
                .iter()
                .any(|ext| file.ends_with(ext))
            && file
                .split('/')
                .all(|s| !s.is_empty() && s != "." && s != ".." && identifier(s, 220))
            && !file.contains(':')
    })
}

fn emit(source: &str, window: &str, failure: Failure) {
    let Failure {
        event_id,
        domain,
        operation,
        level,
        code,
        message,
        request_id,
        frames,
        occurrences,
        ..
    } = failure;
    let context = json!({ "code": code, "frames": frames, "occurrences": occurrences });
    let level_name = match level {
        LogLevel::Error => "ERROR",
        LogLevel::Warn => "WARN",
        LogLevel::Info => "INFO",
        LogLevel::Debug => "DEBUG",
        LogLevel::Trace => "TRACE",
    };
    // Keep a small rolling copy of safe events so delayed disk failures and
    // dropped queue entries are available when Output next polls.
    let line = json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "level": level_name,
        "fields": {
            "source": source, "window": window, "event_id": event_id,
            "domain": domain, "operation": operation, "message": message,
            "request_id": request_id, "context": context.to_string(),
        }
    })
    .to_string();
    {
        let mut recent = RECENT.lock().unwrap_or_else(|poison| poison.into_inner());
        if recent.iter().any(|(id, _)| id == &event_id) {
            return;
        }
        if recent.len() == RECENT_LIMIT {
            recent.pop_front();
        }
        recent.push_back((event_id.clone(), line));
    }
    macro_rules! write {
        ($level:expr) => {
            tracing::event!(target: "tunnelde_lib::diagnostics", $level,
                source, window, event_id, domain, operation, message,
                request_id = request_id.as_deref(), context = %context)
        };
    }
    match level {
        LogLevel::Error => write!(tracing::Level::ERROR),
        LogLevel::Warn => write!(tracing::Level::WARN),
        LogLevel::Info => write!(tracing::Level::INFO),
        LogLevel::Debug => write!(tracing::Level::DEBUG),
        LogLevel::Trace => write!(tracing::Level::TRACE),
    }
}

pub(crate) fn memory_snapshot() -> String {
    RECENT
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .iter()
        .map(|(_, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[track_caller]
pub(crate) fn native(domain: &'static str, operation: &'static str, error: &AppError) {
    let code = error.code();
    let message = error.to_string();
    let level = if message.ends_with(".cancelled") || message.ends_with(".canceled") {
        LogLevel::Debug
    } else if matches!(code, "validation" | "notFound" | "update") {
        LogLevel::Warn
    } else {
        LogLevel::Error
    };
    let location = std::panic::Location::caller();
    let frames = source_location(location.file(), location.line(), location.column())
        .into_iter()
        .collect();
    native_event(
        domain,
        operation,
        code,
        safe_message(&message),
        level,
        frames,
    );
}

/// Observe a best-effort Tauri operation that cannot propagate an error to a caller.
#[track_caller]
pub(crate) fn observe_tauri<T>(
    domain: &'static str,
    operation: &'static str,
    result: tauri::Result<T>,
) {
    if let Err(error) = result {
        native(domain, operation, &error.into());
    }
}

pub(crate) fn source_location(file: &str, line: u32, column: u32) -> Option<String> {
    let normalized = file.replace('\\', "/");
    let relative = normalized.strip_prefix("src/").or_else(|| {
        normalized
            .rsplit_once("/src/")
            .map(|(_, relative)| relative)
    })?;
    let frame = format!("src/{relative}:{line}:{column}");
    safe_frame(&frame).then_some(frame)
}

pub(crate) fn native_event(
    domain: &'static str,
    operation: &'static str,
    code: &'static str,
    message: &str,
    level: LogLevel,
    frames: Vec<String>,
) {
    let event_id = uuid::Uuid::new_v4().to_string();
    if !crate::platform::logging::initialized() {
        eprintln!("[{event_id}] {domain}.{operation}: {message} ({code})");
    }
    emit(
        "native",
        "process",
        Failure {
            event_id,
            domain: domain.into(),
            operation: operation.into(),
            level,
            code: code.into(),
            message: message.into(),
            request_id: None,
            frames,
            occurrences: None,
            _timestamp: String::new(),
        },
    );
}

#[tauri::command]
pub fn diagnostics_report(webview: Webview, mut event: Failure) -> AppResult<bool> {
    validate(&event)?;
    event.message = safe_message(&event.message).into();
    event.domain = format!("frontend.{}", event.domain);
    let window = if webview.label() == "main" {
        "main"
    } else {
        "satellite"
    };
    emit("frontend", window, event);
    Ok(crate::platform::logging::disk_available())
}

fn validate(event: &Failure) -> AppResult<()> {
    for (key, value) in [("domain", &event.domain), ("operation", &event.operation)] {
        if !identifier(value, 128) {
            return Err(invalid(key));
        }
    }
    if !identifier(&event.event_id, 64) {
        return Err(invalid("eventId"));
    }
    if !matches!(
        event.code.as_str(),
        "validation"
            | "notFound"
            | "update"
            | "io"
            | "internal"
            | "database"
            | "ssh"
            | "runtime"
            | "unknown"
    ) {
        return Err(invalid("code"));
    }
    if event
        .request_id
        .as_deref()
        .is_some_and(|s| !identifier(s, 128))
    {
        return Err(invalid("requestId"));
    }
    if event.frames.len() > 12 || event.frames.iter().any(|s| !safe_frame(s)) {
        return Err(invalid("frames"));
    }
    if event.message.len() > 128 || event._timestamp.len() > 64 {
        return Err(invalid("text"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_error_messages_and_locations_to_diagnostic_data() {
        assert_eq!(
            safe_message("panel.viewState.duplicateKey"),
            "panel.viewState.duplicateKey"
        );
        assert_eq!(
            safe_message("Cannot connect to internal.example.com"),
            "Operation failed"
        );
        assert!(safe_frame("src/lib/panels/viewState.tsx:12:3"));
        assert_eq!(
            source_location("/home/example-user/project/src/logs.rs", 12, 3).as_deref(),
            Some("src/logs.rs:12:3")
        );
        assert!(safe_frame("assets/main-aaa.js:1:643"));
        for bad in [
            "/home/example-user/src/Foo.ts:1:2",
            "src/../secret.ts:12:1",
            "src/Foo.ts?credential=123:12:1",
        ] {
            assert!(!safe_frame(bad));
        }
    }
}
