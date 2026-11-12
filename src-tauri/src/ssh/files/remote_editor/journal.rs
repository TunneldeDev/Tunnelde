//! Persistence and observation boundary for owned editor transactions.
use super::*;

pub(super) trait Journal: Send + Sync + 'static {
    fn cleanup_admission(
        &self,
        _sftp: &SftpSession,
        _record: &Record,
    ) -> impl std::future::Future<Output = AppResult<Option<native_save::runtime::Mutation>>> + Send
    {
        async { Ok(None) }
    }
    fn admission(
        &self,
        _sftp: &SftpSession,
        _session: &str,
        _record: &Record,
    ) -> impl std::future::Future<Output = AppResult<Option<native_save::runtime::Mutation>>> + Send
    {
        async { Ok(None) }
    }
    fn create(&self, record: &Record) -> AppResult<()>;
    fn persist(&self, record: &Record) -> AppResult<()>;
    fn forget(&self, record: &Record) -> AppResult<()>;
    fn current(&self, record: &Record) -> AppResult<Record>;
    fn writable(&self, address: &str, path: &str) -> AppResult<()>;
    fn changed(&self);
    fn published(&self, session_id: &str);
}

impl Journal for AppHandle {
    async fn cleanup_admission(
        &self,
        sftp: &SftpSession,
        record: &Record,
    ) -> AppResult<Option<native_save::runtime::Mutation>> {
        let session = session_for(self, record)?;
        let state = self.state::<AppState>();
        let identity = state.ssh.identity(&session)?;
        if let Some(reference) = &record.admission {
            let receipt = record
                .receipt
                .as_ref()
                .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
            state
                .native_saves
                .resume_editor_cleanup(
                    &identity,
                    sftp,
                    &[record.path.clone(), record.directory.clone()],
                    (&record.id, receipt.generation()),
                    reference,
                )
                .await
                .map(Some)
        } else {
            self.admission(sftp, &session, record).await
        }
    }
    async fn admission(
        &self,
        sftp: &SftpSession,
        session: &str,
        record: &Record,
    ) -> AppResult<Option<native_save::runtime::Mutation>> {
        let state = self.state::<AppState>();
        let identity = state.ssh.identity(session)?;
        state
            .native_saves
            .reserve_editor_mutation(
                &identity,
                sftp,
                &[record.path.clone(), record.directory.clone()],
                &record.id,
                record
                    .receipt
                    .as_ref()
                    .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?
                    .generation(),
            )
            .await
    }
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
            || current.admission != record.admission
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
