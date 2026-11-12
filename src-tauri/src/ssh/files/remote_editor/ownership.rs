//! Only settled original requests may leave a durable cleanup continuation.
use super::*;

pub(super) async fn finish(
    active: Option<native_save::runtime::ActiveMutation>,
    record: &Record,
    complete: bool,
) -> AppResult<()> {
    if let Some(active) = active {
        if complete {
            active.settle().await?;
        } else if recovery::require_settled(record).is_ok() {
            active.park_editor_cleanup().await?;
        }
        // An unknown cleanup request never receives continuation authority.
    }
    Ok(())
}
