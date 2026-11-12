//! Real local transactions held at the final publication-admission boundary.
use super::*;
use crate::services::files::operations::{Budget, Cancellation};
use std::sync::{atomic::AtomicUsize, mpsc};
use std::time::Duration;
use tokio::sync::{oneshot, Semaphore};

struct Checked {
    revoked: Arc<AtomicBool>,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
    admitted_first: bool,
}
impl policy::Policy for Checked {
    fn authorize(&self) -> AppResult<()> {
        if self.revoked.load(Ordering::Acquire) {
            Err(AppError::validation("test.revoked"))
        } else {
            Ok(())
        }
    }
    fn check(&self, _: &Path, _: &str) -> AppResult<()> {
        self.authorize()
    }
    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        if self.admitted_first {
            self.authorize()?;
            job.commit()?;
        }
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        if !self.admitted_first {
            self.authorize()?;
            job.commit()?;
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn final_publication_admission_orders_cancellation_revocation_and_noop_notification() {
    for (noop, revoke, admitted) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, false),
        (false, false, true),
        (false, true, true),
        (true, false, true),
    ] {
        let f = Fixture::new();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Arc::new(Budget::with_capacity(capacity.clone(), write::ERRORS));
        let revoked = Arc::new(AtomicBool::new(false));
        let notifications = Arc::new(AtomicUsize::new(0));
        let notify = notifications.clone();
        let (entered, waiting) = oneshot::channel();
        let (release, blocker) = mpsc::channel();
        let policy = Checked {
            revoked: revoked.clone(),
            entered: Mutex::new(Some(entered)),
            release: Mutex::new(blocker),
            admitted_first: admitted,
        };
        let path = display_path(&f.file);
        let save = tokio::spawn(async move {
            saving::execute(
                &budget,
                None,
                path,
                if noop { "original" } else { "approved" }.into(),
                Some("original".into()),
                policy,
                move || {
                    notify.fetch_add(1, Ordering::AcqRel);
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f.disk(), "original");
        assert_eq!(capacity.available_permits(), 0);
        if revoke {
            revoked.store(true, Ordering::Release);
        }
        save.abort();
        assert!(save.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while capacity.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            f.disk(),
            if admitted && !noop {
                "approved"
            } else {
                "original"
            }
        );
        assert_eq!(notifications.load(Ordering::Acquire), usize::from(admitted));
        f.clean();
    }
}

#[tokio::test]
async fn revoked_worker_is_rejected_before_opening_an_unavailable_target() {
    struct Denied;
    impl policy::Policy for Denied {
        fn authorize(&self) -> AppResult<()> {
            Err(AppError::validation("test.revoked"))
        }
        fn check(&self, _: &Path, _: &str) -> AppResult<()> {
            panic!("revoked worker read target")
        }
        fn admit(&self, _: &Cancellation) -> AppResult<()> {
            panic!("revoked worker admitted publication")
        }
    }
    let f = Fixture::new();
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Budget::with_capacity(capacity.clone(), write::ERRORS);
    let result = saving::execute(
        &budget,
        None,
        display_path(&f.root.join("missing.txt")),
        "draft".into(),
        None,
        Denied,
        || panic!("revoked worker notified"),
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "test.revoked");
    assert_eq!(capacity.available_permits(), 1);
    assert_eq!(f.disk(), "original");
    f.clean();
}
