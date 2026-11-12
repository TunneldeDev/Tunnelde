use super::*;
use crate::services::files::operations::Budget;
use std::time::Duration;
use tokio::sync::Semaphore;

async fn settled(capacity: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_save_keeps_actual_worker_charged_and_busy_save_keeps_its_draft() {
    let f = Fixture::new();
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), write::ERRORS));
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (release, blocker) = std::sync::mpsc::channel();
    let blocker = Mutex::new(blocker);
    let owned = budget.clone();
    let path = display_path(&f.file);
    let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let notified = notifications.clone();
    let save = tokio::spawn(async move {
        save_with_budget(
            &owned,
            None,
            path,
            "abandoned".into(),
            None,
            move |_, _| {
                if let Some(entered) = entered.lock().unwrap().take() {
                    entered.send(()).unwrap();
                    blocker
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
                Ok(())
            },
            move || {
                notified.fetch_add(1, Ordering::AcqRel);
            },
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    save.abort();
    assert!(save.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    let result = save_with_budget(
        &budget,
        None,
        display_path(&f.file),
        "next draft".into(),
        None,
        |_, _| panic!("rejected save reached disk transaction"),
        || panic!("rejected save notified"),
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "editor.saveBusy");
    assert_eq!(f.disk(), "original");
    release.send(()).unwrap();
    settled(&capacity).await;
    assert_eq!(f.disk(), "original");
    assert_eq!(notifications.load(Ordering::Acquire), 0);
    f.clean();
    save_with_budget(
        &budget,
        None,
        display_path(&f.file),
        "retry".into(),
        Some("original".into()),
        |_, _| Ok(()),
        || {},
    )
    .await
    .unwrap();
    assert_eq!(f.disk(), "retry");
    f.clean();
}

#[test]
fn cancelled_save_queued_in_the_blocking_pool_performs_no_disk_work() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let f = Fixture::new();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Budget::with_capacity(capacity.clone(), write::ERRORS);
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let (release, blocker) = std::sync::mpsc::channel();
        let pool = tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            blocker.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        waiting.await.unwrap();
        let mut save = Box::pin(save_with_budget(
            &budget,
            None,
            display_path(&f.file),
            "abandoned".into(),
            None,
            |_, _| panic!("cancelled queued worker opened the target"),
            || panic!("cancelled queued save notified"),
        ));
        assert!(futures_util::poll!(&mut save).is_pending());
        assert_eq!(capacity.available_permits(), 0);
        drop(save);
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        pool.await.unwrap();
        settled(&capacity).await;
        assert_eq!(f.disk(), "original");
        f.clean();
    });
}

#[tokio::test]
async fn failed_save_worker_releases_admission_without_exposing_private_panic_data() {
    let f = Fixture::new();
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Budget::with_capacity(capacity.clone(), write::ERRORS);
    let result = save_with_budget(
        &budget,
        None,
        display_path(&f.file),
        "draft".into(),
        None,
        |_, _| panic!("private local file diagnostic"),
        || panic!("failed worker notified"),
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "editor.saveWorkerFailed");
    assert_eq!(capacity.available_permits(), 1);
    assert_eq!(f.disk(), "original");
    f.clean();
    save_with_budget(
        &budget,
        None,
        display_path(&f.file),
        "retry".into(),
        Some("original".into()),
        |_, _| Ok(()),
        || {},
    )
    .await
    .unwrap();
    assert_eq!(f.disk(), "retry");
    f.clean();
}
