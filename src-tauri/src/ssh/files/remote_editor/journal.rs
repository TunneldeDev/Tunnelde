//! Persistence and observation boundary for owned editor transactions.
use super::*;

pub(super) trait Journal: Send + Sync + 'static {
    fn create(&self, record: &Record) -> AppResult<()>;
    fn persist(&self, record: &Record) -> AppResult<()>;
    fn forget(&self, record: &Record) -> AppResult<()>;
    fn current(&self, record: &Record) -> AppResult<Record>;
    fn writable(&self, address: &str, path: &str) -> AppResult<()>;
    fn changed(&self);
    fn published(&self, session_id: &str);
}

impl Journal for AppHandle {
    fn create(&self, record: &Record) -> AppResult<()> {
        self.state::<AppState>()
            .db
            .with(|conn| storage::create(conn, record))
    }
    fn persist(&self, record: &Record) -> AppResult<()> {
        persist(self, record)
    }
    fn forget(&self, record: &Record) -> AppResult<()> {
        forget(self, record)
    }

    fn current(&self, record: &Record) -> AppResult<Record> {
        let current = self
            .state::<AppState>()
            .db
            .with(|conn| storage::load(conn, &record.id))?
            .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
        if current.token != record.token
            || current.directory != record.directory
            || current.path != record.path
            || current.host_id != record.host_id
            || current.address != record.address
        {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        Ok(current)
    }
    fn writable(&self, address: &str, path: &str) -> AppResult<()> {
        for record in records(self)? {
            if record.address == address && record.path == path {
                recovery::require_settled(&record)?;
            }
        }
        Ok(())
    }
    fn changed(&self) {
        let _ = self.emit(EVENT, ());
    }
    fn published(&self, session_id: &str) {
        let _ = self.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":"files","sessionId":session_id}),
        );
    }
}
