use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::ops::Range;
use std::sync::atomic::AtomicU64;

#[derive(Clone, Copy, Debug)]
pub(super) struct Plan {
    pub workers: usize,
    pub chunk: u64,
    pub requests: usize,
}

impl Plan {
    pub fn for_file(settings: &crate::settings::Settings, size: u64, remote: bool) -> Self {
        let chunk = match settings.transfer_chunk_kib {
            0 if size < 64 * 1024 * 1024 => 1024 * 1024,
            0 => 4 * 1024 * 1024,
            kib => u64::from(kib) * 1024,
        };
        let workers = if !settings.transfer_optimization || !remote || size < 512 * 1024 {
            1
        } else if settings.transfer_concurrency != 0 {
            usize::from(settings.transfer_concurrency)
        } else if size < 8 * 1024 * 1024 {
            2
        } else {
            4
        };
        let workers = workers
            .min(size.div_ceil(chunk).clamp(1, 8) as usize)
            .clamp(1, 8);
        Self {
            workers,
            chunk,
            requests: if settings.transfer_requests == 0 {
                32 / workers
            } else {
                usize::from(settings.transfer_requests).clamp(1, 64 / workers)
            },
        }
    }
}

pub(super) fn config(settings: &crate::settings::Settings) -> russh_sftp::client::Config {
    let workers = match settings.transfer_concurrency {
        0 => 4,
        value => usize::from(value).clamp(1, 8),
    };
    let requests = if settings.transfer_optimization {
        match settings.transfer_requests {
            0 => 32 / workers,
            value => usize::from(value).clamp(1, 64 / workers),
        }
    } else {
        1
    };
    russh_sftp::client::Config {
        max_concurrent_reads: requests,
        max_concurrent_writes: requests,
        request_timeout_secs: 30,
        ..Default::default()
    }
}

pub(super) async fn resize(
    target: &Endpoint,
    sftp: Option<&SftpSession>,
    length: u64,
) -> AppResult<()> {
    reject_destination_link(target, sftp).await?;
    match sftp {
        Some(sftp) => {
            let mut attributes = russh_sftp::protocol::FileAttributes::empty();
            attributes.size = Some(length);
            sftp.set_metadata(&target.path, attributes)
                .await
                .map_err(map_sftp)?;
        }
        None => {
            tokio::fs::OpenOptions::new()
                .write(true)
                .open(&target.path)
                .await?
                .set_len(length)
                .await?;
        }
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_plans_bound_parallelism_and_requests() {
        let mut settings = crate::settings::Settings::default();
        assert_eq!(Plan::for_file(&settings, 0, true).workers, 1);
        assert_eq!(Plan::for_file(&settings, 100 * 1024, true).workers, 1);
        assert_eq!(Plan::for_file(&settings, 3 * 1024 * 1024, true).workers, 2);
        assert_eq!(
            Plan::for_file(&settings, 128 * 1024 * 1024, true).workers,
            4
        );
        assert_eq!(Plan::for_file(&settings, u64::MAX, false).workers, 1);
        for workers in [1, 2, 4, 8] {
            settings.transfer_concurrency = workers;
            settings.transfer_requests = 32;
            assert!(config(&settings).max_concurrent_writes * usize::from(workers) <= 64);
        }
        settings.transfer_optimization = false;
        assert_eq!(Plan::for_file(&settings, u64::MAX, true).workers, 1);
        assert_eq!(config(&settings).max_concurrent_reads, 1);
    }
}
