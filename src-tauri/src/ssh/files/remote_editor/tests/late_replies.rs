//! Delivery expiry retains the actual worker, not a new attempt at the save.
use super::workers::*;
use super::*;
use std::time::Duration;

#[tokio::test]
async fn late_terminal_replies_settle_only_the_original_worker_without_republication() {
    for kind in [
        "mkdir-before",
        "mkdir-after",
        "stage-close",
        "publish-before",
        "publish-after",
        "reject-publish",
    ] {
        let f = Arc::new(Fixture::new());
        match kind {
            "mkdir-before" => f.probe.hold_mkdir_before.store(true, Ordering::SeqCst),
            "mkdir-after" => f.probe.hold_mkdir_after.store(true, Ordering::SeqCst),
            "stage-close" => f.probe.hold_close.store(true, Ordering::SeqCst),
            "publish-before" | "reject-publish" => {
                f.probe.hold_commit_before.store(true, Ordering::SeqCst)
            }
            "publish-after" => f.probe.hold_commit.store(true, Ordering::SeqCst),
            _ => unreachable!(),
        }
        if kind == "reject-publish" {
            *f.probe.failure.lock().unwrap() = "rename".into();
        }
        let (budget, capacity) = budget();
        let journal = MemoryJournal::default();
        let save = spawn_checked_timing(
            budget.clone(),
            f.clone(),
            journal.clone(),
            "approved",
            policy::Native,
            lifetime::Timing {
                delivery: Duration::from_secs(1),
                observation: Duration::from_secs(5),
            },
        );
        if kind.starts_with("mkdir") {
            notified(&f.probe.mkdir_started).await;
        } else if kind == "stage-close" {
            notified(&f.probe.close_started).await;
        } else {
            notified(&f.probe.commit_started).await;
        }
        assert_eq!(
            save.await.unwrap().unwrap_err().to_string(),
            "editor.remoteSaveWaiting",
            "{kind}"
        );
        let record = journal.records.lock().unwrap()[0].clone();
        assert_eq!(lifetime::snapshot().get(&record.id), Some(&true));
        assert_eq!(capacity.available_permits(), 0);
        let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
        assert!(lock.try_lock().is_err());
        assert!(Reservation::acquire(&record.id, true).is_err());
        assert_eq!(journal.published.load(Ordering::SeqCst), 0);
        assert_eq!(
            spawn_checked(
                budget.clone(),
                f.clone(),
                journal.clone(),
                "overtake",
                policy::Native
            )
            .await
            .unwrap()
            .unwrap_err()
            .to_string(),
            "editor.remoteSaveBusy"
        );
        if kind.starts_with("mkdir") {
            f.probe.release_mkdir.notify_one();
        } else if kind == "stage-close" {
            f.probe.release_close.notify_one();
        } else {
            f.probe.release_commit.notify_one();
        }
        until(|| capacity.available_permits() == 1).await;
        let published = matches!(kind, "publish-before" | "publish-after");
        assert_eq!(
            f.disk(),
            if published { "approved" } else { "original" },
            "{kind}"
        );
        assert_eq!(
            f.probe.commits.load(Ordering::SeqCst),
            usize::from(published)
        );
        assert_eq!(
            journal.published.load(Ordering::SeqCst),
            usize::from(published)
        );
        assert!(journal.records.lock().unwrap().is_empty(), "{kind}");
        assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1, "{kind}");
        assert!(!lifetime::snapshot().contains_key(&record.id));
        assert!(lock.try_lock().is_ok());
        assert_eq!(journal.changed.load(Ordering::SeqCst), 2);
        *f.probe.failure.lock().unwrap() = String::new();
        let mut next = request(&f, "next generation");
        next.baseline = Some(f.disk());
        let remote = f.clone();
        saving::save_with(
            &budget,
            next,
            policy::Native,
            move |job| opening(remote, job),
            journal.clone(),
        )
        .await
        .unwrap();
        assert_eq!(f.disk(), "next generation");
        assert_eq!(
            journal.published.load(Ordering::SeqCst),
            usize::from(published) + 1
        );
        assert!(journal.records.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn cancelled_delivery_exposes_the_retained_worker_until_its_late_reply() {
    let f = Arc::new(Fixture::new());
    f.probe.hold_close.store(true, Ordering::SeqCst);
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let save = spawn_checked(
        budget,
        f.clone(),
        journal.clone(),
        "cancelled",
        policy::Native,
    );
    notified(&f.probe.close_started).await;
    let record = journal.records.lock().unwrap()[0].clone();
    assert_eq!(lifetime::snapshot().get(&record.id), Some(&false));
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    assert_eq!(lifetime::snapshot().get(&record.id), Some(&true));
    assert_eq!(capacity.available_permits(), 0);
    f.probe.release_close.notify_one();
    until(|| capacity.available_permits() == 1).await;
    assert_eq!(f.disk(), "original");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert!(journal.records.lock().unwrap().is_empty());
    assert!(!lifetime::snapshot().contains_key(&record.id));
}

#[tokio::test]
async fn absolute_observation_horizon_retires_a_worker_still_waiting_for_the_path_lock() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    let held = lock.lock().await;
    let save = spawn_checked_timing(
        budget,
        f.clone(),
        journal.clone(),
        "not admitted",
        policy::Native,
        lifetime::Timing {
            delivery: Duration::from_millis(200),
            observation: Duration::from_secs(1),
        },
    );
    until(|| f.probe.realpaths.load(Ordering::SeqCst) > 0).await;
    assert_eq!(
        save.await.unwrap().unwrap_err().to_string(),
        "editor.remoteSaveWaiting"
    );
    assert_eq!(capacity.available_permits(), 0);
    until(|| capacity.available_permits() == 1).await;
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    assert_eq!(f.disk(), "original");
    drop(held);
}
