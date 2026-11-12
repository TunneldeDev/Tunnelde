use super::*;
use crate::services::files::operations::{Budget, Cancellation};
use std::future::Future;
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Clone, Default)]
struct MemoryJournal {
    records: Arc<Mutex<Vec<Record>>>,
    published: Arc<AtomicUsize>,
    changed: Arc<AtomicUsize>,
}
impl Journal for MemoryJournal {
    fn persist(&self, record: &Record) -> AppResult<()> {
        let mut records = self.records.lock().unwrap();
        records.retain(|existing| existing.id != record.id);
        records.push(record.clone());
        Ok(())
    }
    fn forget(&self, record: &Record) -> AppResult<()> {
        self.records.lock().unwrap().retain(|r| r.id != record.id);
        Ok(())
    }
    fn changed(&self) {
        self.changed.fetch_add(1, Ordering::SeqCst);
    }
    fn published(&self, _: &str) {
        self.published.fetch_add(1, Ordering::SeqCst);
    }
}

fn request(f: &Fixture, content: &str) -> saving::Request {
    saving::Request {
        session_id: "session".into(),
        host_id: "host".into(),
        address: f.root.to_string_lossy().into_owned(),
        path: "/note.txt".into(),
        content: content.into(),
        baseline: Some("original".into()),
    }
}

async fn opening(
    f: Arc<Fixture>,
    job: Cancellation,
) -> AppResult<(
    SftpSession,
    impl Future<Output = AppResult<remote_commit::Replacement>> + Send,
)> {
    job.check()?;
    let sftp = f.client().await;
    Ok((sftp, async move { f.replacement().await }))
}

fn spawn_save(
    budget: Arc<Budget>,
    f: Arc<Fixture>,
    journal: MemoryJournal,
    content: &str,
) -> tokio::task::JoinHandle<AppResult<()>> {
    let request = request(&f, content);
    tokio::spawn(async move {
        saving::save_with(&budget, request, move |job| opening(f, job), journal).await
    })
}

async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn notified(notify: &tokio::sync::Notify) {
    tokio::time::timeout(Duration::from_secs(5), notify.notified())
        .await
        .unwrap();
}

fn budget() -> (Arc<Budget>, Arc<Semaphore>) {
    let capacity = Arc::new(Semaphore::new(1));
    (
        Arc::new(Budget::with_capacity(
            capacity.clone(),
            write::REMOTE_ERRORS,
        )),
        capacity,
    )
}

#[tokio::test]
async fn cancelled_staging_retains_capacity_lock_and_reservation_until_cleanup_finishes() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    f.probe.hold_close.store(true, Ordering::SeqCst);
    let save = spawn_save(
        budget.clone(),
        f.clone(),
        journal.clone(),
        "abandoned draft",
    );
    notified(&f.probe.close_started).await;
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    assert!(lock.try_lock().is_err());
    let record = journal.records.lock().unwrap()[0].clone();
    assert!(Reservation::acquire(&record.id, true).is_err());
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(lock.try_lock().is_err());
    assert!(Reservation::acquire(&record.id, true).is_err());
    assert_eq!(
        spawn_save(budget.clone(), f.clone(), journal.clone(), "retained draft")
            .await
            .unwrap()
            .unwrap_err()
            .to_string(),
        "editor.remoteSaveBusy"
    );
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 1);
    assert_eq!(f.disk(), "original");
    f.probe.release_close.notify_one();
    until(|| capacity.available_permits() == 1).await;
    assert_eq!(f.disk(), "original");
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    assert_eq!(journal.changed.load(Ordering::SeqCst), 1);
    assert!(lock.try_lock().is_ok());
    spawn_save(budget, f.clone(), journal.clone(), "retry")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.disk(), "retry");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 1);
    assert_eq!(journal.published.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_during_path_lock_wait_never_creates_staging_or_publishes() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    let held = lock.lock().await;
    let save = spawn_save(budget, f.clone(), journal.clone(), "cancelled draft");
    until(|| f.probe.realpaths.load(Ordering::SeqCst) >= 1).await;
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    drop(held);
    until(|| capacity.available_permits() == 1).await;
    assert_eq!(f.disk(), "original");
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelled_delivery_after_publication_still_waits_for_ack_and_notifies_once() {
    let f = Arc::new(Fixture::new());
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    f.probe.hold_commit.store(true, Ordering::SeqCst);
    let save = spawn_save(budget, f.clone(), journal.clone(), "published");
    notified(&f.probe.commit_started).await;
    assert_eq!(f.disk(), "published");
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(journal.published.load(Ordering::SeqCst), 0);
    let lock = lock_for(format!("{}\0/note.txt", f.root.display()));
    assert!(lock.try_lock().is_err());
    f.probe.release_commit.notify_one();
    until(|| capacity.available_permits() == 1).await;
    assert_eq!(f.disk(), "published");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 1);
    assert_eq!(journal.published.load(Ordering::SeqCst), 1);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
    assert!(lock.try_lock().is_ok());
}

#[tokio::test]
async fn no_op_and_conflict_do_not_negotiate_replacement_or_create_staging() {
    let f = Arc::new(Fixture::new());
    let (budget, _) = budget();
    let journal = MemoryJournal::default();
    *f.probe.failure.lock().unwrap() = "unsupported".into();
    spawn_save(budget.clone(), f.clone(), journal.clone(), "original")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(journal.published.load(Ordering::SeqCst), 1);
    let mut request = request(&f, "new draft");
    request.baseline = Some("outdated".into());
    let remote = f.clone();
    assert_eq!(
        saving::save_with(
            &budget,
            request,
            move |job| opening(remote, job),
            journal.clone()
        )
        .await
        .unwrap_err()
        .to_string(),
        "editor.remoteFileChanged"
    );
    assert_eq!(f.probe.mkdirs.load(Ordering::SeqCst), 0);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(f.disk(), "original");
}

#[tokio::test]
async fn cancelled_cleanup_retains_its_worker_and_reservation_until_the_server_reply() {
    let f = Arc::new(Fixture::new());
    let sftp = f.client().await;
    let record = f.record();
    staged_save(
        &sftp,
        &f.replacement().await.unwrap(),
        "/note.txt",
        "/note.txt",
        "saved",
        "original",
        &record,
    )
    .await
    .unwrap();
    sftp.close().await.unwrap();
    let (budget, capacity) = budget();
    let journal = MemoryJournal::default();
    journal.persist(&record).unwrap();
    f.probe.hold_rmdir.store(true, Ordering::SeqCst);
    let owned = budget.clone();
    let remote = f.clone();
    let saved = record.clone();
    let storage = journal.clone();
    let cleanup = tokio::spawn(async move {
        retained::retry_with(
            &owned,
            saved,
            move || async move { Ok(remote.client().await) },
            storage,
        )
        .await
    });
    notified(&f.probe.rmdir_started).await;
    assert!(journal.records.lock().unwrap()[0].removing_marker);
    cleanup.abort();
    assert!(cleanup.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(Reservation::acquire(&record.id, true).is_err());
    let remote = f.clone();
    assert_eq!(
        retained::retry_with(
            &budget,
            record.clone(),
            move || async move { Ok(remote.client().await) },
            journal.clone()
        )
        .await
        .unwrap_err()
        .to_string(),
        "editor.remoteSaveBusy"
    );
    f.probe.release_rmdir.notify_one();
    until(|| capacity.available_permits() == 1).await;
    assert_eq!(f.disk(), "saved");
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
    assert!(journal.records.lock().unwrap().is_empty());
    assert_eq!(journal.changed.load(Ordering::SeqCst), 2);
    assert!(Reservation::acquire(&record.id, true).is_ok());
}
