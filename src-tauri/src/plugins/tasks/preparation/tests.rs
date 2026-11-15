use super::*;
use crate::error::AppError;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[tokio::test(flavor = "current_thread")]
async fn task_preparation_cancel_timeout_and_revocation_prevent_late_launch_admission() {
    for reason in ["cancelled", "timedOut", "revoked"] {
        let (send, mut cancel) = watch::channel(false);
        let revoked = Arc::new(AtomicBool::new(false));
        let auth = revoked.clone();
        let admitted = Arc::new(AtomicBool::new(false));
        let launched = admitted.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let result = prepare(
                crate::services::credentials::inspect(move || {
                    ready.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(10)).unwrap();
                    finished.send(()).unwrap();
                    Ok(())
                }),
                &mut cancel,
                Instant::now() + Duration::from_secs(1),
                move || {
                    if auth.load(Ordering::SeqCst) {
                        Err(AppError::validation("pluginSecurity.changed"))
                    } else {
                        Ok(())
                    }
                },
            )
            .await?;
            match result {
                Outcome::Ready(_) => {
                    launched.store(true, Ordering::SeqCst);
                    Ok::<_, AppError>("ready")
                }
                Outcome::Stopped(reason) => Ok(reason),
            }
        });
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap();
        match reason {
            "cancelled" => {
                send.send_replace(true);
            }
            "revoked" => revoked.store(true, Ordering::SeqCst),
            _ => {}
        }
        let result = tokio::time::timeout(Duration::from_secs(3), task).await;
        release.send(()).unwrap();
        done.await.unwrap();
        assert_eq!(
            result.unwrap().unwrap().unwrap(),
            if reason == "timedOut" {
                "timedOut"
            } else {
                "cancelled"
            }
        );
        assert!(!admitted.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn expired_cancelled_or_revoked_tasks_never_begin_environment_preparation() {
    for reason in 0..3 {
        let (send, mut cancel) = watch::channel(reason == 0);
        let polled = AtomicBool::new(false);
        let expires = if reason == 1 {
            Instant::now()
        } else {
            Instant::now() + Duration::from_secs(3)
        };
        let result = prepare(
            async {
                polled.store(true, Ordering::SeqCst);
                Ok(())
            },
            &mut cancel,
            expires,
            || {
                if reason == 2 {
                    Err(AppError::validation("pluginSecurity.changed"))
                } else {
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert!(matches!(result, Outcome::Stopped(_)));
        assert!(!polled.load(Ordering::SeqCst));
        drop(send);
    }
}

#[tokio::test]
async fn preparation_preserves_original_errors_and_ready_values() {
    let (_send, mut cancel) = watch::channel(false);
    let deadline = Instant::now() + Duration::from_secs(3);
    assert!(matches!(
        prepare(async { Ok(7) }, &mut cancel, deadline, || Ok(()))
            .await
            .unwrap(),
        Outcome::Ready(7)
    ));
    let result = prepare(
        async { Err::<(), _>(AppError::Ssh("vault.load: isolated failure".into())) },
        &mut cancel,
        deadline,
        || Ok(()),
    )
    .await;
    assert_eq!(
        result.err().unwrap().to_string(),
        "vault.load: isolated failure"
    );
}

#[tokio::test]
async fn closed_cancellation_channel_never_admits_a_ready_environment() {
    let (send, mut cancel) = watch::channel(false);
    drop(send);
    let result = prepare(
        async { Ok(()) },
        &mut cancel,
        Instant::now() + Duration::from_secs(3),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(matches!(result, Outcome::Stopped("cancelled")));
}
