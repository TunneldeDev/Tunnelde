use super::*;

#[test]
fn cancellation_and_publication_admission_have_one_winner() {
    for _ in 0..128 {
        let (worker, caller) = Cancellation::new("cancelled");
        let commit = worker.clone();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let start = gate.clone();
        let thread = std::thread::spawn(move || {
            start.wait();
            commit.commit().is_ok()
        });
        gate.wait();
        drop(caller);
        let admitted = thread.join().unwrap();
        assert_eq!(worker.check().is_ok(), admitted);
        assert!(
            worker.commit().is_err(),
            "A publication may be admitted once"
        );
    }
}

#[tokio::test]
async fn admitted_publication_keeps_capacity_until_its_worker_finishes_after_cancellation() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(
        capacity.clone(),
        Errors {
            domain: "test",
            busy: "busy",
            cancelled: "cancelled",
            failed: "failed",
        },
    ));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        owned
            .asynchronous(move |job| async move {
                job.commit()?;
                started.send(()).unwrap();
                wait.await.unwrap();
                job.check()?;
                finished.send(()).unwrap();
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        budget
            .asynchronous(|_| async { Ok(()) })
            .await
            .unwrap_err()
            .to_string(),
        "busy"
    );
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), done)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    budget.asynchronous(|_| async { Ok(()) }).await.unwrap();
}
