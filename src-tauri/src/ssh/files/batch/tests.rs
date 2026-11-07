use super::*;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

#[tokio::test]
async fn overlaps_files_with_a_bounded_width_and_combined_progress() {
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let mut reported = 0;
    run(
        (0..19).collect(),
        4,
        &AtomicBool::new(false),
        |bytes| {
            reported = bytes;
            Ok(())
        },
        |item, progress, _| {
            let (active, peak, finished) = (&active, &peak, &finished);
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                progress.report(item + 1);
                active.fetch_sub(1, Ordering::SeqCst);
                finished.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(finished.load(Ordering::SeqCst), 19);
    assert_eq!(reported, (1..=19).sum::<u64>());
}

#[tokio::test]
async fn failure_stops_new_files_and_drains_started_writers() {
    let started = AtomicUsize::new(0);
    let drained = AtomicUsize::new(0);
    let result = run(
        (0..20).collect(),
        3,
        &AtomicBool::new(false),
        |_| Ok(()),
        |item, _, stop| {
            let (started, drained) = (&started, &drained);
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                if item == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    return Err(AppError::validation("original failure"));
                }
                while !stop.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                // Model waiting for the remote writer's outstanding CLOSE reply.
                tokio::time::sleep(Duration::from_millis(20)).await;
                drained.fetch_add(1, Ordering::SeqCst);
                Err(AppError::Ssh(CANCELLED.into()))
            }
        },
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "original failure");
    assert_eq!(started.load(Ordering::SeqCst), 3);
    assert_eq!(drained.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancellation_drains_active_files_and_starts_no_queued_file() {
    let cancelled = AtomicBool::new(false);
    let started = AtomicUsize::new(0);
    let drained = AtomicUsize::new(0);
    let operation = run(
        (0..20).collect(),
        2,
        &cancelled,
        |_| Ok(()),
        |_, _, stop| {
            let (started, drained) = (&started, &drained);
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                while !stop.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
                drained.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        },
    );
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(operation, async {
            while started.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
            cancelled.store(true, Ordering::SeqCst);
        })
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert_eq!(started.load(Ordering::SeqCst), 2);
    assert_eq!(drained.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn final_rollback_replaces_only_its_own_contribution() {
    let mut reported = 0;
    let result = run(
        vec![0, 1],
        2,
        &AtomicBool::new(false),
        |bytes| {
            reported = bytes;
            Ok(())
        },
        |item, progress, _| async move {
            if item == 0 {
                progress.report(100);
                Ok(())
            } else {
                progress.report(200);
                progress.report(40);
                Err(AppError::validation("writer failed"))
            }
        },
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "writer failed");
    assert_eq!(reported, 140);
}

#[tokio::test]
async fn already_cancelled_batch_never_touches_files() {
    let result = run(
        vec![0, 1],
        4,
        &AtomicBool::new(true),
        |_| Ok(()),
        |_, _, _| async {
            panic!("cancelled task must not start a file");
            #[allow(unreachable_code)]
            Ok(())
        },
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
}

#[tokio::test]
async fn failed_progress_persistence_stops_and_drains_the_batch() {
    let drained = AtomicBool::new(false);
    let result = run(
        vec![0, 1],
        2,
        &AtomicBool::new(false),
        |_| Err(AppError::validation("journal unavailable")),
        |item, progress, stop| {
            let drained = &drained;
            async move {
                if item == 0 {
                    progress.report(1);
                    return Ok(());
                }
                while !stop.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                drained.store(true, Ordering::SeqCst);
                Ok(())
            }
        },
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "journal unavailable");
    assert!(drained.load(Ordering::SeqCst));
}
