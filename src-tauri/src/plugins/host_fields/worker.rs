//! Plugin metadata requests cannot occupy the security-control worker budget.
use crate::{
    error::AppResult,
    services::operations::{Budget, Cancellation, Errors},
};
use std::sync::LazyLock;

pub(super) async fn run<T: Send + 'static>(
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "hostFields.operation",
                busy: "hostFields.operation.busy",
                cancelled: "hostFields.operation.cancelled",
                failed: "hostFields.operation.unavailable",
            },
        )
    });
    WORKERS.blocking(operation).await
}
