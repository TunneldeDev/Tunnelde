//! Persistence and observation boundary for owned editor transactions.
use super::*;

pub(super) trait Journal: Send + Sync + 'static {
    fn persist(&self, record: &Record) -> AppResult<()>;
    fn forget(&self, record: &Record) -> AppResult<()>;
    fn changed(&self);
    fn published(&self, session_id: &str);
}

impl Journal for AppHandle {
    fn persist(&self, record: &Record) -> AppResult<()> {
        persist(self, record)
    }
    fn forget(&self, record: &Record) -> AppResult<()> {
        forget(self, record)
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
