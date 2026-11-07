use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::future::Future;
use tokio::sync::mpsc;

#[derive(Clone)]
pub(super) struct Progress {
    index: usize,
    sender: mpsc::UnboundedSender<(usize, u64)>,
}

impl Progress {
    pub fn report(&self, bytes: u64) {
        let _ = self.sender.send((self.index, bytes));
    }
}

/// File writers must finish before returning, including after an error. Dropping
/// the remaining futures here could race task cleanup against unacknowledged IO.
pub(super) async fn run<T, F, Fut>(
    items: Vec<T>,
    concurrency: usize,
    cancelled: &AtomicBool,
    mut report: impl FnMut(u64) -> AppResult<()>,
    mut operation: F,
) -> AppResult<()>
where
    F: FnMut(T, Progress, Arc<AtomicBool>) -> Fut,
    Fut: Future<Output = AppResult<()>>,
{
    let mut contributions = vec![0_u64; items.len()];
    let mut total = 0_u64;
    let mut items = items.into_iter().enumerate();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let stop = Arc::new(AtomicBool::new(false));
    let mut pending = FuturesUnordered::new();
    let mut error = None;
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(40));
    loop {
        if cancelled.load(Ordering::SeqCst) {
            error.get_or_insert_with(|| AppError::Ssh(CANCELLED.into()));
            stop.store(true, Ordering::SeqCst);
        }
        while error.is_none() && pending.len() < concurrency.clamp(1, 8) {
            let Some((index, item)) = items.next() else {
                break;
            };
            pending.push(operation(
                item,
                Progress {
                    index,
                    sender: sender.clone(),
                },
                stop.clone(),
            ));
        }
        if pending.is_empty() {
            break;
        }
        tokio::select! {
            biased;
            _ = tick.tick() => {}
            Some((index, bytes)) = receiver.recv() => {
                total = total - contributions[index] + bytes;
                contributions[index] = bytes;
                if let Err(failure) = report(total) {
                    error.get_or_insert(failure);
                    stop.store(true, Ordering::SeqCst);
                }
            }
            Some(result) = pending.next() => {
                if let Err(failure) = result {
                    error.get_or_insert(failure);
                    stop.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    // A writer can report a rollback immediately before completing. Include all
    // such updates before the parent persists its final or paused task record.
    while let Ok((index, bytes)) = receiver.try_recv() {
        total = total - contributions[index] + bytes;
        contributions[index] = bytes;
        if let Err(failure) = report(total) {
            error.get_or_insert(failure);
        }
    }
    error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests;
