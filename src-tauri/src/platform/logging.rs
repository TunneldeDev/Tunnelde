use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::OnceLock;

use tracing_appender::non_blocking::{ErrorCounter, WorkerGuard};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::diagnostics::{self, failure, LogEntry, LogLevel, LogOrigin};

static INITIALIZED: AtomicBool = AtomicBool::new(false);
static DISK_FAILED: AtomicBool = AtomicBool::new(false);
static DROPPED: OnceLock<ErrorCounter> = OnceLock::new();

pub(crate) fn initialized() -> bool {
    INITIALIZED.load(Relaxed)
}

// Once an event has been lost, keep the warning visible for the session.
pub(crate) fn disk_available() -> bool {
    if DROPPED
        .get()
        .is_some_and(|counter| counter.dropped_lines() > 0)
    {
        disk_failed();
    }
    initialized() && !DISK_FAILED.load(Relaxed) && DROPPED.get().is_some()
}

fn disk_failed() {
    if !DISK_FAILED.swap(true, Relaxed) {
        eprintln!(
            "Tunnelde diagnostic log is unavailable. Recent error records are held in memory."
        );
    }
}

struct ReportWriteFailure<W>(W);
impl<W: Write> Write for ReportWriteFailure<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes).inspect_err(|_| disk_failed())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush().inspect_err(|_| disk_failed())
    }
}

/// Keep console and in-memory diagnostics running even if the configured log
/// directory is unavailable. The returned guard drains the file queue on exit.
pub fn init(log_dir: &Path) -> Option<WorkerGuard> {
    let mut guard = None;
    let writer = std::fs::create_dir_all(log_dir)
        .ok()
        .and_then(|()| {
            tracing_appender::rolling::RollingFileAppender::builder()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_suffix("tunnelde.jsonl.log")
                .build(log_dir)
                .ok()
        })
        .map(|file| {
            let (writer, worker) = tracing_appender::non_blocking(ReportWriteFailure(file));
            let _ = DROPPED.set(writer.error_counter());
            guard = Some(worker);
            writer
        });
    if writer.is_none() {
        disk_failed();
    }

    let filter = EnvFilter::try_from_env("TUNNELDE_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,tunnelde_lib=debug"));
    let file_layer = writer.map(|writer| {
        tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_current_span(false)
            .with_writer(writer)
    });
    let console_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_writer(io::stderr);
    if tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(console_layer)
        .try_init()
        .is_ok()
    {
        INITIALIZED.store(true, Relaxed);
    } else {
        disk_failed();
    }

    std::panic::set_hook(Box::new(|info| {
        let frames = info
            .location()
            .and_then(|location| {
                failure::source_location(location.file(), location.line(), location.column())
            })
            .into_iter()
            .collect();
        failure::native_event(
            "runtime",
            "panic",
            "internal",
            "Unhandled native panic",
            LogLevel::Error,
            frames,
        );
    }));
    if disk_available() {
        // This record is a simple check that the rotating sink was configured.
        let _ = diagnostics::write(
            LogOrigin::Native,
            LogEntry {
                domain: Some("diagnostics".into()),
                operation: Some("initialize".into()),
                message: "Diagnostic log initialized".into(),
                ..Default::default()
            },
        );
    } else {
        failure::native_event(
            "diagnostics",
            "initialize",
            "io",
            "Diagnostic log unavailable",
            LogLevel::Warn,
            Vec::new(),
        );
    }
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_failure_is_visible_outside_the_appender() {
        let mut writer = ReportWriteFailure(io::BufWriter::new(FailingWriter));
        writer.write_all(b"event").unwrap();
        assert!(writer.flush().is_err());
        assert!(DISK_FAILED.load(Relaxed));
    }

    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("failed"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
