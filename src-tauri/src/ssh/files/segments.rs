use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::ops::Range;
use std::sync::atomic::AtomicU64;

mod planning;

pub(super) use planning::{config, Plan};

/// Parallel writes are bounded to one window. The caller journals its contiguous
/// prefix before entering; a crash can only invalidate this uncommitted window.
#[allow(clippy::too_many_arguments)]
pub(super) async fn copy_window(
    files: &range_io::Files<'_>,
    range: Range<u64>,
    plan: Plan,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> AppResult<()> {
    let plan = plan.for_window(range.end.saturating_sub(range.start));
    let stop = AtomicBool::new(cancel.load(Ordering::SeqCst));
    let transferred = AtomicU64::new(0);
    let mut workers = FuturesUnordered::new();
    let mut offset = range.start;
    while offset < range.end {
        let end = offset.saturating_add(plan.chunk).min(range.end);
        workers.push(files.segment(offset..end, plan.requests, &stop, &transferred));
        offset = end;
    }
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(40));
    let mut error = None;
    let mut reported = 0;
    while !workers.is_empty() {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if cancel.load(Ordering::SeqCst) {
                    stop.store(true, Ordering::SeqCst);
                    error.get_or_insert_with(|| AppError::Ssh(CANCELLED.into()));
                }
            }
            result = workers.next() => {
                if let Some(Err(failure)) = result {
                    error.get_or_insert(failure);
                    stop.store(true, Ordering::SeqCst);
                }
            }
        }
        let bytes = transferred.load(Ordering::Relaxed);
        if bytes > reported {
            progress(bytes - reported);
            reported = bytes;
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
