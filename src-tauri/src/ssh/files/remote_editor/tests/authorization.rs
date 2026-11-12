//! Real protocol writes with delayed requests and worker-side policy failures.
use super::workers::*;
use super::*;
use crate::services::files::operations::Cancellation;

struct Checked {
    revoked: Arc<AtomicBool>,
    checks: Arc<AtomicUsize>,
    reject_final: bool,
}
impl policy::Policy for Checked {
    async fn check(&self, _: &SftpSession, _: &str, original: &str) -> AppResult<()> {
        let prior = self.checks.fetch_add(1, Ordering::SeqCst);
        if self.revoked.load(Ordering::SeqCst) {
            return Err(AppError::validation("plugin.permissionDenied:sftp.write"));
        }
        if original != "original" {
            return Err(AppError::validation("plugin.tools.fileChanged"));
        }
        if self.reject_final && prior > 1 {
            return Err(AppError::validation("plugin.tools.targetChanged"));
        }
        Ok(())
    }
    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(AppError::validation("plugin.tools.clientRevoked"));
        }
        job.commit()
    }
}

fn checked(reject_final: bool) -> (Checked, Arc<AtomicBool>, Arc<AtomicUsize>) {
    let revoked = Arc::new(AtomicBool::new(false));
    let checks = Arc::new(AtomicUsize::new(0));
    (
        Checked {
            revoked: revoked.clone(),
            checks: checks.clone(),
            reject_final,
        },
        revoked,
        checks,
    )
}

#[tokio::test]
async fn authorization_revoked_during_path_lock_wait_prevents_staging() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    let held = lock.lock().await;
    let (policy, revoked, checks) = checked(false);
    let save = spawn_checked(budget, f.clone(), journal.clone(), "unapproved", policy);
    until(|| f.probe.realpaths.load(Ordering::SeqCst) > 0).await;
    revoked.store(true, Ordering::SeqCst);
    drop(held);
    assert!(save.await.unwrap().is_err());
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    assert_eq!(f.disk(), "original");
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert_eq!(capacity.available_permits(), 1);
}

#[tokio::test]
async fn revocation_during_staging_cleans_owned_data_without_publishing() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let (policy, revoked, checks) = checked(false);
    f.probe.hold_close.store(true, Ordering::SeqCst);
    let save = spawn_checked(budget, f.clone(), journal.clone(), "unapproved", policy);
    notified(&f.probe.close_started).await;
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    revoked.store(true, Ordering::SeqCst);
    assert_eq!(capacity.available_permits(), 0);
    f.probe.release_close.notify_one();
    assert!(save.await.unwrap().is_err());
    assert_eq!(f.disk(), "original");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
    assert_eq!(capacity.available_permits(), 1);
}

#[tokio::test]
async fn final_target_policy_failure_preserves_original_and_cleans_staging() {
    let f = Arc::new(Fixture::new());
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    let (policy, _, checks) = checked(true);
    let error = spawn_checked(budget, f.clone(), journal.clone(), "redirected", policy)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "plugin.tools.targetChanged");
    assert_eq!(checks.load(Ordering::SeqCst), 3);
    assert_eq!(f.disk(), "original");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
}

#[tokio::test]
async fn changed_bytes_during_lock_wait_reject_tools_without_optional_baseline() {
    let f = Arc::new(Fixture::new());
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    let held = lock.lock().await;
    let (policy, _, _) = checked(false);
    let mut request = request(&f, "unapproved");
    request.baseline = None;
    let remote = f.clone();
    let saved = journal.clone();
    let save = tokio::spawn(async move {
        saving::save_with(
            &budget,
            request,
            policy,
            move |job| opening(remote, job),
            saved,
        )
        .await
    });
    until(|| f.probe.realpaths.load(Ordering::SeqCst) > 0).await;
    std::fs::write(f.root.join("note.txt"), "external edit").unwrap();
    drop(held);
    assert_eq!(
        save.await.unwrap().unwrap_err().to_string(),
        "plugin.tools.fileChanged"
    );
    assert_eq!(f.disk(), "external edit");
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn post_admission_revocation_does_not_erase_acknowledged_publication() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let (policy, revoked, _) = checked(false);
    f.probe.hold_commit.store(true, Ordering::SeqCst);
    let save = spawn_checked(budget, f.clone(), journal.clone(), "approved", policy);
    notified(&f.probe.commit_started).await;
    revoked.store(true, Ordering::SeqCst);
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(f.disk(), "approved");
    f.probe.release_commit.notify_one();
    save.await.unwrap().unwrap();
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 1);
    assert_eq!(journal.published.load(Ordering::SeqCst), 1);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(capacity.available_permits(), 1);
}

#[tokio::test]
async fn revoked_noop_does_not_report_a_reconciled_publication() {
    let f = Arc::new(Fixture::new());
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    let (policy, revoked, _) = checked(false);
    revoked.store(true, Ordering::SeqCst);
    assert!(
        spawn_checked(budget, f.clone(), journal.clone(), "original", policy)
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert_eq!(f.disk(), "original");
}
