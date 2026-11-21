//! Origin-bound clipboard writes: never hold ownership across synchronous OS IO.
use super::Effect;
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::sync::Arc;
use tauri_plugin_clipboard_manager::ClipboardExt;

async fn write(
    admit: impl FnOnce() -> AppResult<()> + Send + 'static,
    effect: impl FnOnce() -> AppResult<()> + Send + 'static,
) -> AppResult<Value> {
    crate::services::credentials::inspect(move || {
        // Recheck inside the actual bounded worker, not before it can queue.
        // Once admitted, external OS writes cannot promise rollback. Original
        // lifetime stays captured until the OS operation itself returns.
        admit()?;
        effect()?;
        Ok(Value::Null)
    })
    .await
}

pub(super) async fn copy(origin: Arc<Effect>, text: String) -> AppResult<Value> {
    let app = origin.app.clone();
    write(
        move || origin.with_current(|| Ok(())),
        move || {
            app.clipboard()
                .write_text(text)
                .map_err(|_| AppError::internal("clipboard.unavailable"))
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::operations::WorkLifetime;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };

    #[tokio::test]
    async fn denied_original_never_writes_and_admitted_os_work_survives_lost_delivery() {
        let wrote = Arc::new(AtomicBool::new(false));
        let written = wrote.clone();
        assert!(write(
            || Err(AppError::validation("panel.window.staleOwner")),
            move || {
                written.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .is_err());
        assert!(!wrote.load(Ordering::SeqCst));

        let guard = Arc::new(());
        let weak = Arc::downgrade(&guard);
        let (admitted, admission) = tokio::sync::oneshot::channel();
        let (release, released) = mpsc::channel();
        let written = wrote.clone();
        let task = tokio::spawn(WorkLifetime::new(guard).scope(write(
            || Ok(()),
            move || {
                let _ = admitted.send(());
                released.recv().unwrap();
                written.store(true, Ordering::SeqCst);
                Ok(())
            },
        )));
        admission.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(
            weak.upgrade().is_some(),
            "delivery loss released OS work fence"
        );
        assert!(!wrote.load(Ordering::SeqCst));
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while weak.upgrade().is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(wrote.load(Ordering::SeqCst));
    }
}
