//! Durable exact-item cleanup runs after domain/settings guards have ended.
use super::cleanup_wake::Wake;
use super::*;
use std::sync::Arc;

pub(crate) struct Runtime {
    pub(crate) run: uuid::Uuid,
    cleaning: Arc<Wake>,
}
impl Runtime {
    pub(crate) fn initialize(
        db: &crate::db::Database,
        vault: &crate::vault::Vault,
    ) -> AppResult<Self> {
        let run = uuid::Uuid::new_v4();
        let service = native::Service::new(db, vault, run)?;
        // Exclusive storage ownership and no credential workers exist yet.
        while service.recover_startup_page()? != 0 {}
        Ok(Self {
            run,
            cleaning: Arc::new(Wake::default()),
        })
    }
}
struct Running(Arc<Wake>, bool);
impl Drop for Running {
    fn drop(&mut self) {
        if self.1 {
            self.0.abort();
        }
    }
}

pub(crate) fn schedule(app: &AppHandle) {
    let state = app.state::<AppState>();
    let busy = state.credentials.cleaning.clone();
    if !busy.request() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut running = Running(busy, true);
        // A finite pass, not a retry loop. Failed claims remain durable and are
        // not reclaimed by this run; later unrelated records can still proceed.
        loop {
            let mut more = true;
            for _ in 0..256 {
                let worker_app = app.clone();
                let result = WORKERS
                    .blocking(move |job| {
                        let state = worker_app.state::<AppState>();
                        native::Service::new(&state.db, &state.vault, state.credentials.run)?
                            .retire_one(job)
                    })
                    .await;
                match result {
                    Ok(true) => {}
                    Ok(false) => {
                        more = false;
                        break;
                    }
                    Err(error) => {
                        tracing::warn!(target:"credentials", reason=error.code(),
                        stage="cleanup",action="retain_original_cleanup_record",
                        "Credential cleanup did not complete");
                        more = false;
                        break;
                    }
                }
            }
            // Wake and runner release share one lock. A producer racing the final
            // empty check either keeps this runner or starts exactly one new one.
            if !running.0.next(more) {
                running.1 = false;
                break;
            }
        }
    });
}
