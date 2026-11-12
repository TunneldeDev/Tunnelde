//! Real protocol effects deliberately outlive the request timeout.
use super::workers::*;
use super::*;

#[tokio::test]
async fn unknown_mkdir_and_publication_survive_missing_paths_and_late_server_effects() {
    for (publish, after_effect) in [(false, false), (false, true), (true, false), (true, true)] {
        let f = Arc::new(Fixture::new());
        f.probe.short_timeout.store(true, Ordering::SeqCst);
        if publish {
            if after_effect {
                f.probe.hold_commit.store(true, Ordering::SeqCst);
            } else {
                f.probe.hold_commit_before.store(true, Ordering::SeqCst);
            }
        } else if after_effect {
            f.probe.hold_mkdir_after.store(true, Ordering::SeqCst);
        } else {
            f.probe.hold_mkdir_before.store(true, Ordering::SeqCst);
        }
        let (budget, capacity) = budget();
        let journal = MemoryJournal::default();
        let save = spawn_checked(
            budget.clone(),
            f.clone(),
            journal.clone(),
            "approved",
            policy::Native,
        );
        if publish {
            notified(&f.probe.commit_started).await;
        } else {
            notified(&f.probe.mkdir_started).await;
        }
        assert_eq!(capacity.available_permits(), 0);
        let result = tokio::time::timeout(std::time::Duration::from_secs(4), save)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        let record = journal.records.lock().unwrap()[0].clone();
        assert_eq!(record.error.as_deref(), Some("editor.remoteOutcomeUnknown"));
        assert_eq!(
            super::super::recovery::require_settled(&record)
                .unwrap_err()
                .to_string(),
            "editor.remoteOutcomeUnknown"
        );
        assert_eq!(journal.published.load(Ordering::SeqCst), 0);
        assert_eq!(capacity.available_permits(), 1);
        assert_eq!(
            spawn_checked(
                budget.clone(),
                f.clone(),
                journal.clone(),
                "must not overtake unknown",
                policy::Native
            )
            .await
            .unwrap()
            .unwrap_err()
            .to_string(),
            "editor.remoteOutcomeUnknown"
        );
        let before: Vec<_> = std::fs::read_dir(&f.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            retained::retry_with(
                &budget,
                record.clone(),
                move || async move {
                    panic!("unknown operation must be rejected before opening another connection")
                },
                journal.clone()
            )
            .await
            .unwrap_err()
            .to_string(),
            "editor.remoteOutcomeUnknown"
        );
        let after: Vec<_> = std::fs::read_dir(&f.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(before, after);
        if publish {
            f.probe.release_commit.notify_one();
        } else {
            f.probe.release_mkdir.notify_one();
        }
        if publish {
            until(|| f.disk() == "approved").await;
            assert_eq!(f.probe.commits.load(Ordering::SeqCst), 1);
        } else {
            until(|| f.probe.mkdirs.load(Ordering::SeqCst) == 1).await;
            assert_eq!(f.disk(), "original");
        }
        assert_eq!(journal.records.lock().unwrap().len(), 1);
        assert_eq!(journal.published.load(Ordering::SeqCst), 0);
        assert!(f
            .root
            .join(record.directory.trim_start_matches('/'))
            .exists());
        // The server task has completed its held handler before Fixture deletes
        // this test-owned directory. The record remains Unknown even after effect.
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn retired_cleanup_cannot_resurrect_a_stale_captured_record() {
    let f = Arc::new(Fixture::new());
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    let record = f.record();
    let remote = f.clone();
    let error = retained::retry_with(
        &budget,
        record,
        move || async move { Ok(remote.client().await) },
        journal.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "editor.cleanupMissing");
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(f.disk(), "original");
}

#[tokio::test]
async fn acknowledged_publication_notifies_once_even_when_local_terminal_checkpoint_fails() {
    #[derive(Clone, Default)]
    struct FailingJournal {
        memory: MemoryJournal,
        fail: Arc<AtomicBool>,
    }
    impl Journal for FailingJournal {
        fn create(&self, r: &Record) -> AppResult<()> {
            self.memory.create(r)
        }
        fn persist(&self, r: &Record) -> AppResult<()> {
            if self.fail.load(Ordering::SeqCst) {
                Err(AppError::internal("disk full"))
            } else {
                self.memory.persist(r)
            }
        }
        fn forget(&self, r: &Record) -> AppResult<()> {
            self.memory.forget(r)
        }
        fn current(&self, r: &Record) -> AppResult<Record> {
            self.memory.current(r)
        }
        fn writable(&self, address: &str, path: &str) -> AppResult<()> {
            self.memory.writable(address, path)
        }
        fn changed(&self) {
            self.memory.changed()
        }
        fn published(&self, session: &str) {
            self.memory.published(session);
            self.fail.store(true, Ordering::SeqCst);
        }
    }
    let f = Arc::new(Fixture::new());
    let remote = f.clone();
    let (budget, capacity) = budget();
    let journal = FailingJournal::default();
    let error = saving::save_with(
        &budget,
        request(&f, "published"),
        policy::Native,
        move |job| opening(remote, job),
        journal.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "disk full");
    assert_eq!(f.disk(), "published");
    assert_eq!(journal.memory.published.load(Ordering::SeqCst), 1);
    assert_eq!(capacity.available_permits(), 1);
    let record = journal.memory.records.lock().unwrap()[0].clone();
    assert_eq!(
        super::super::recovery::require_settled(&record)
            .unwrap_err()
            .to_string(),
        "editor.remoteOutcomeUnknown"
    );
    assert!(f
        .root
        .join(record.directory.trim_start_matches('/'))
        .exists());
}

#[tokio::test]
async fn serialized_raw_staging_respects_the_negotiated_server_write_limit() {
    let f = Arc::new(Fixture::new());
    f.probe.write_limit.store(1024, Ordering::SeqCst);
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    let content = "界".repeat(4096);
    spawn_checked(budget, f.clone(), journal.clone(), &content, policy::Native)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.disk(), content);
    assert_eq!(journal.published.load(Ordering::SeqCst), 1);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
}
