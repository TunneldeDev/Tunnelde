#[derive(Clone, Copy, Debug)]
pub(in crate::ssh::files) struct Plan {
    pub workers: usize,
    pub chunk: u64,
    pub requests: usize,
}

const MIN_AUTO_CHUNK: u64 = 1024 * 1024;
const MAX_AUTO_CHUNK: u64 = 16 * 1024 * 1024;
const LARGE_FILE: u64 = 64 * 1024 * 1024;
const SMALL_AUTO_WINDOW: u64 = 16 * 1024 * 1024;
const LARGE_AUTO_WINDOW: u64 = 64 * 1024 * 1024;

impl Plan {
    pub fn window_end(self, offset: u64, size: u64, replay_end: Option<u64>) -> u64 {
        offset
            .saturating_add(self.chunk.saturating_mul(self.workers as u64))
            .max(replay_end.unwrap_or(offset))
            .min(size)
    }

    pub(super) fn for_window(self, length: u64) -> Self {
        Self {
            // A resumed window can be larger than the new chunk/concurrency
            // settings. Each worker streams its range; it never buffers it all.
            chunk: self.chunk.max(length.div_ceil(self.workers as u64)),
            ..self
        }
    }

    pub fn for_file(settings: &crate::settings::Settings, size: u64, remote: bool) -> Self {
        let optimized = settings.transfer_optimization && remote;
        let workers = if !optimized || size < 512 * 1024 {
            1
        } else if settings.transfer_concurrency != 0 {
            usize::from(settings.transfer_concurrency)
        } else if size < 8 * 1024 * 1024 {
            2
        } else {
            4
        }
        .clamp(1, 8);
        let window_budget = if size < LARGE_FILE {
            SMALL_AUTO_WINDOW
        } else {
            LARGE_AUTO_WINDOW
        };
        let chunk = match settings.transfer_chunk_kib {
            // Stream a bounded share of this file before a checkpoint barrier.
            // A fixed 1 MiB range cannot fill eight negotiated 256 KiB requests;
            // it also drains every worker for repeated metadata round trips.
            // This is a replay extent, not an allocation: packet budgets and
            // each local worker's 1 MiB buffer remain independently bounded.
            // Share one window budget rather than multiplying it when users
            // increase concurrency; short files do not need a 64 MiB window.
            0 if optimized => size
                .div_ceil(workers as u64)
                .min(window_budget / workers as u64)
                .clamp(MIN_AUTO_CHUNK, MAX_AUTO_CHUNK),
            0 if size < LARGE_FILE => MIN_AUTO_CHUNK,
            0 => 4 * 1024 * 1024,
            kib => u64::from(kib) * 1024,
        };
        let workers = workers
            .min(size.div_ceil(chunk).clamp(1, 8) as usize)
            .clamp(1, 8);
        Self {
            workers,
            chunk,
            requests: if !settings.transfer_optimization {
                1
            } else if settings.transfer_requests == 0 {
                32 / workers
            } else {
                usize::from(settings.transfer_requests).clamp(1, 64 / workers)
            },
        }
    }
}

pub(in crate::ssh::files) fn config(
    settings: &crate::settings::Settings,
) -> russh_sftp::client::Config {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_windows_rewrite_the_old_extent_with_the_new_worker_budget() {
        let mut settings = crate::settings::Settings {
            transfer_chunk_kib: 256,
            transfer_requests: 64,
            ..Default::default()
        };
        let old_end = 128 * 1024 * 1024;
        for workers in 1..=8 {
            settings.transfer_concurrency = workers;
            let plan = Plan::for_file(&settings, old_end + 17, true);
            let end = plan.window_end(1, old_end + 17, Some(old_end));
            assert_eq!(end, old_end);
            let replay = plan.for_window(end - 1);
            assert!((end - 1).div_ceil(replay.chunk) <= u64::from(workers));
            assert_eq!(replay.workers, usize::from(workers));
            assert_eq!(replay.requests, plan.requests);
            assert!(replay.workers * replay.requests <= 64);
        }
        let plan = Plan {
            workers: 8,
            chunk: u64::MAX,
            requests: 1,
        };
        assert_eq!(plan.window_end(1, u64::MAX, None), u64::MAX);
        assert_eq!(
            (u64::MAX - 1).div_ceil(plan.for_window(u64::MAX - 1).chunk),
            1
        );
        let plan = Plan {
            workers: 3,
            chunk: 7,
            requests: 2,
        };
        assert_eq!(plan.window_end(20, 100, None), 41);
        assert_eq!(plan.window_end(20, 100, Some(80)), 80);
        assert_eq!(plan.window_end(90, 100, Some(95)), 100);
        assert_eq!(plan.for_window(61).chunk, 21);
    }

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
        assert_eq!(Plan::for_file(&settings, u64::MAX, true).requests, 1);
        assert_eq!(config(&settings).max_concurrent_reads, 1);
    }

    #[test]
    fn automatic_extents_fill_the_pipeline_without_unbounded_replay() {
        let mut settings = crate::settings::Settings::default();
        for workers in [0, 1, 2, 4, 8] {
            settings.transfer_concurrency = workers;
            for size in [
                0,
                1,
                512 * 1024 - 1,
                512 * 1024,
                8 * 1024 * 1024 - 1,
                8 * 1024 * 1024,
                32 * 1024 * 1024 + 73,
                128 * 1024 * 1024 + 73,
                u64::MAX,
            ] {
                let plan = Plan::for_file(&settings, size, true);
                assert!((1..=8).contains(&plan.workers));
                assert!(plan.workers * plan.requests <= 32);
                assert!((MIN_AUTO_CHUNK..=MAX_AUTO_CHUNK).contains(&plan.chunk));
                assert!(plan.window_end(0, size, None) <= 64 * 1024 * 1024);
                if size < 64 * 1024 * 1024 {
                    assert!(plan.window_end(0, size, None) <= 16 * 1024 * 1024);
                }
                if size <= 16 * 1024 * 1024 {
                    assert_eq!(plan.window_end(0, size, None), size);
                }
                if size >= 8 * 1024 * 1024 {
                    assert!(plan.chunk >= plan.requests as u64 * 256 * 1024);
                }
            }
        }
    }

    #[test]
    fn explicit_chunks_and_unoptimized_or_local_defaults_are_preserved() {
        for remote in [false, true] {
            for optimized in [false, true] {
                let mut settings = crate::settings::Settings {
                    transfer_optimization: optimized,
                    ..Default::default()
                };
                for size in [1024, 32 * 1024 * 1024 + 73, u64::MAX] {
                    for chunk in [256, 1024, 4096, 16384] {
                        settings.transfer_chunk_kib = chunk;
                        let plan = Plan::for_file(&settings, size, remote);
                        assert_eq!(plan.chunk, u64::from(chunk) * 1024);
                        assert!(plan.workers * plan.requests <= 64);
                    }
                    settings.transfer_chunk_kib = 0;
                    if !remote || !optimized {
                        let plan = Plan::for_file(&settings, size, remote);
                        assert_eq!(plan.workers, 1);
                        let legacy_chunk = if size < 64 * 1024 * 1024 {
                            1024 * 1024
                        } else {
                            4 * 1024 * 1024
                        };
                        assert_eq!(plan.chunk, legacy_chunk);
                    }
                }
            }
        }
    }
}
