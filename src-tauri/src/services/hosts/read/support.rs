use super::*;
use tokio::sync::Semaphore;

pub(super) struct HeldDatabase {
    release: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<std::thread::JoinHandle<()>>,
}

impl HeldDatabase {
    pub async fn lock(db: Arc<Database>) -> Self {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            db.with(|_| {
                entered.send(()).unwrap();
                let _ = wait.recv_timeout(Duration::from_secs(5));
                Ok(())
            })
            .unwrap();
        });
        ready.await.unwrap();
        Self {
            release: Some(release),
            owner: Some(owner),
        }
    }
}

impl Drop for HeldDatabase {
    fn drop(&mut self) {
        let _ = self.release.take().unwrap().send(());
        self.owner.take().unwrap().join().unwrap();
    }
}

pub(super) fn budget() -> (Arc<Budget>, Arc<Semaphore>) {
    let capacity = Arc::new(Semaphore::new(1));
    (
        Arc::new(Budget::with_capacity(capacity.clone(), ERRORS)),
        capacity,
    )
}

pub(super) async fn available(capacity: Arc<Semaphore>) {
    let permit = tokio::time::timeout(Duration::from_secs(2), capacity.acquire_owned())
        .await
        .expect("reader did not release actual capacity")
        .unwrap();
    drop(permit);
}
