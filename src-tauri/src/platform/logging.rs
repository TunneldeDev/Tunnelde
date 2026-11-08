use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::error::AppResult;

/// Daily-rotated JSON logs next to the app data. The returned guard must
/// outlive the process so buffered lines are flushed on exit.
pub fn init(log_dir: &Path) -> AppResult<WorkerGuard> {
    std::fs::create_dir_all(log_dir)?;

    let writer = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_suffix("tunnelde.jsonl.log")
        .build(log_dir)
        .map_err(|error| crate::error::AppError::internal(error.to_string()))?;
    let (writer, guard) = tracing_appender::non_blocking(writer);

    let filter = EnvFilter::try_from_env("TUNNELDE_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,tunnelde_lib=debug"));

    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_current_span(false)
        .with_writer(writer);

    let console_layer = tracing_subscriber::fmt::layer().with_target(false);

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(console_layer)
        .try_init();

    std::panic::set_hook(Box::new(|info| {
        tracing::error!(panic = %info, "unhandled panic");
    }));

    Ok(guard)
}
