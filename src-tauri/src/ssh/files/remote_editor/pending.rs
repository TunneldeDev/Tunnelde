//! Independent recovery stores must remain visible when another store fails.
use super::*;

const REMOTE: &str = "recovery-remote-store";
const LOCAL: &str = "recovery-local-store";

pub(super) fn diagnostic_id(id: &str) -> bool {
    matches!(id, REMOTE | LOCAL)
}

pub(super) fn legacy(app: &AppHandle) -> Vec<PendingCleanup> {
    let mut rows = visible(remote_pending(app), REMOTE);
    rows.extend(visible(local_editor::pending(app), LOCAL));
    rows
}

fn visible(result: AppResult<Vec<PendingCleanup>>, id: &str) -> Vec<PendingCleanup> {
    match result {
        Ok(rows) => rows,
        Err(_) => {
            // Keep malformed file contents/credentials out of diagnostics.
            tracing::warn!(target: "files.recovery", source = id,
                reason = "editor.recoveryStoreUnavailable", "Editor recovery store could not be read");
            vec![PendingCleanup {
                id: id.into(),
                path: String::new(),
                directory: String::new(),
                address: String::new(),
                source: "diagnostic",
                action: Some("reload"),
                updated_at: 0,
                error: Some("editor.recoveryStoreUnavailable".into()),
                running: false,
            }]
        }
    }
}

pub(super) fn worker_failed() -> Vec<PendingCleanup> {
    let mut rows = visible(Err(AppError::internal("editor.nativeWorkerFailed")), REMOTE);
    rows.extend(visible(
        Err(AppError::internal("editor.nativeWorkerFailed")),
        LOCAL,
    ));
    rows
}

pub(super) fn retry(app: &AppHandle, id: &str) -> AppResult<()> {
    match id {
        REMOTE => remote_pending(app).map(|_| ()),
        LOCAL => local_editor::pending(app).map(|_| ()),
        _ => Err(AppError::validation("editor.cleanupMissing")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_failed_store_remains_a_diagnostic_and_does_not_hide_another_stores_rows() {
        let mut rows = visible(Err(AppError::internal("private evidence")), REMOTE);
        let mut other = visible(Err(AppError::internal("private evidence")), LOCAL);
        other[0].id = "retained-local-operation".into();
        rows.extend(visible(Ok(other), LOCAL));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, REMOTE);
        assert_eq!(rows[0].action, Some("reload"));
        assert!(!serde_json::to_string(&rows)
            .unwrap()
            .contains("private evidence"));
        assert_eq!(rows[1].id, "retained-local-operation");
        assert!(diagnostic_id(LOCAL));
        assert!(!diagnostic_id("native-operation"));
    }
}
