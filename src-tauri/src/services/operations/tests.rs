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

struct Effect(std::sync::mpsc::Sender<&'static str>);
impl Drop for Effect {
    fn drop(&mut self) {
        let _ = self.0.send("settled");
    }
}
fn budget() -> Budget {
    Budget::new(
        1,
        Errors {
            domain: "test",
            busy: "busy",
            cancelled: "cancelled",
            failed: "failed",
        },
    )
}

#[tokio::test]
async fn timed_out_blocking_work_retains_effect_through_unreceived_result_cleanup() {
    let (settled, done) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (cleaned, cleanup) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(
        WorkLifetime::new(Effect(settled.clone())).scope(async move {
            budget()
                .blocking(move |cancel| {
                    cancel.commit()?;
                    started.send(()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(Delivery::new((), move |_| {
                        // This cleanup is an actual effect too, not just reply data.
                        let _ = settled.send("cleanup");
                        let _ = cleaned.send(());
                    }))
                })
                .await
        }),
    );
    ready.await.unwrap();
    caller.abort();
    assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    cleanup.await.unwrap();
    assert_eq!(
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
        "cleanup"
    );
    assert_eq!(
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
        "settled"
    );
}

#[tokio::test]
async fn detached_nested_async_and_blocking_workers_inherit_the_effect_not_the_caller_wait() {
    let (settled, done) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (expire, expired) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(WorkLifetime::new(Effect(settled)).scope(async move {
        budget()
            .asynchronous(move |_| async move {
                // Drop this inner wait while its blocking worker is still live.
                let work = budget();
                let work = work.blocking(move |_| {
                    started.send(()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(())
                });
                tokio::pin!(work);
                let result = tokio::select! {
                    result = &mut work => Ok(result),
                    _ = expired => tokio::time::timeout(std::time::Duration::ZERO, work).await,
                };
                assert!(result.is_err());
                Ok(())
            })
            .await
    }));
    ready.await.unwrap();
    expire.send(()).unwrap();
    caller.await.unwrap().unwrap();
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    assert_eq!(
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
        "settled"
    );
}

#[tokio::test]
async fn work_lifetime_is_scoped_and_released_on_worker_panic() {
    let (settled, done) = std::sync::mpsc::channel();
    let result: AppResult<()> = WorkLifetime::new(Effect(settled))
        .scope(async {
            budget()
                .blocking(|_| panic!("isolated worker failure"))
                .await
        })
        .await;
    assert_eq!(result.unwrap_err().to_string(), "failed");
    assert_eq!(
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
        "settled"
    );
    assert!(done.try_recv().is_err());
    budget().asynchronous(|_| async { Ok(()) }).await.unwrap();
}
