use super::*;
use std::sync::RwLock;
use tokio::sync::{Mutex, Semaphore};

pub(super) struct Fixture {
    pub db: Database,
    pub serial: Mutex<()>,
    pub settings: RwLock<Settings>,
}
impl Fixture {
    pub fn new() -> Arc<Self> {
        let mut settings = Settings::default();
        settings.sanitize();
        Arc::new(Self {
            db: Database::in_memory().unwrap(),
            serial: Mutex::new(()),
            settings: RwLock::new(settings),
        })
    }
    pub fn run<T>(
        &self,
        check: impl Fn() -> AppResult<()>,
        project: impl FnOnce(&Settings, String) -> AppResult<T>,
    ) -> AppResult<T> {
        ordered(
            &self.db,
            &self.serial,
            || self.settings.read().unwrap().clone(),
            check,
            || Ok(()),
            project,
        )
    }
    pub fn save(&self, settings: Settings) -> String {
        let revision = self
            .db
            .with(|conn| crate::services::settings::repository::save(conn, &settings))
            .unwrap();
        *self.settings.write().unwrap() = settings;
        revision
    }
    pub fn remove_settings_table(&self) {
        self.db
            .with(|conn| {
                conn.execute_batch("DROP TABLE settings")?;
                Ok(())
            })
            .unwrap();
    }
}

pub(super) struct HeldDatabase {
    release: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<std::thread::JoinHandle<()>>,
}
impl HeldDatabase {
    pub async fn lock(fixture: Arc<Fixture>) -> Self {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            fixture
                .db
                .with(|_| {
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
        .expect("worker did not release admission")
        .unwrap();
    drop(permit);
}
