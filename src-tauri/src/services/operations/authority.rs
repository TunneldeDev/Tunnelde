//! Private synchronous publication authority carried with an actual effect.
//! Never serialized or inherited by unrelated spawned tasks. Slow OS/network
//! work checks before admission; only short final transactions run under it.
use crate::error::AppResult;

pub(crate) trait Authority: Send + Sync {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::AppError,
        services::operations::{Budget, Errors, WorkLifetime},
    };
    use std::sync::{Arc, Mutex};
    struct Gate(Arc<Mutex<bool>>);
    impl Authority for Gate {
        fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
            let live = self.0.lock().unwrap();
            if !*live {
                return Err(AppError::validation("expired"));
            }
            effect()
        }
    }
    #[tokio::test]
    async fn authority_is_inherited_by_workers_and_holds_only_short_final_transactions() {
        let live = Arc::new(Mutex::new(true));
        let gate = Arc::new(Gate(live.clone()));
        let weak = Arc::downgrade(&gate);
        let work = WorkLifetime::authorized(gate);
        let budget = Budget::new(
            1,
            Errors {
                domain: "test",
                busy: "busy",
                cancelled: "cancelled",
                failed: "failed",
            },
        );
        work.scope(async {
            budget
                .blocking({
                    let live = live.clone();
                    move |_| {
                        assert!(
                            live.try_lock().is_ok(),
                            "slow worker must not hold origin lock"
                        );
                        WorkLifetime::with_current(|| {
                            assert!(
                                live.try_lock().is_err(),
                                "final publication must hold origin lock"
                            );
                            Ok(())
                        })?;
                        *live.lock().unwrap() = false;
                        assert!(WorkLifetime::with_current(|| -> AppResult<()> {
                            panic!("expired publication")
                        })
                        .is_err());
                        Ok(())
                    }
                })
                .await
                .unwrap();
            let denied: AppResult<()> = budget
                .blocking(|_| panic!("retired authority reached queued work"))
                .await;
            assert_eq!(denied.unwrap_err().to_string(), "expired");
            budget.asynchronous(|_| async { Ok(()) }).await.unwrap_err();
            // An unrelated spawn is not given a grant by the task-local scope.
            tokio::spawn(async { WorkLifetime::check() })
                .await
                .unwrap()
                .unwrap();
        })
        .await;
        assert!(weak.upgrade().is_none());
        WorkLifetime::check().unwrap();
    }
    #[tokio::test]
    async fn retirement_keeps_fence_but_does_not_require_new_consent_for_exact_cleanup() {
        let live = Arc::new(Mutex::new(false));
        let gate = Arc::new(Gate(live));
        let weak = Arc::downgrade(&gate);
        WorkLifetime::authorized(gate)
            .retirement()
            .scope(async {
                assert!(weak.upgrade().is_some());
                WorkLifetime::check().unwrap();
            })
            .await;
        assert!(weak.upgrade().is_none());
    }
}
