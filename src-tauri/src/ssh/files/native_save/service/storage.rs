//! Only the bounded blocking workers call these synchronous SQLite/keyring operations.
use super::*;
use crate::ssh::files::native_save::{contracts::operation::Control, journal::DispatchPermit};

pub(super) struct Storage<S> {
    journal: Mutex<Journal>,
    secrets: S,
}
impl<S: Secrets> Storage<S> {
    pub fn new(journal: Journal, secrets: S) -> Self {
        Self {
            journal: Mutex::new(journal),
            secrets,
        }
    }
    pub fn journal(&self) -> journal::Result<std::sync::MutexGuard<'_, Journal>> {
        self.journal.lock().map_err(|_| journal::Error::Unavailable)
    }
    pub fn reserve(&self, binding: Binding, token: String) -> journal::Result<Record> {
        let reserved = self.journal()?.reserve(binding)?;
        self.journal()?.provision(&reserved, || {
            self.secrets.create(&reserved.secret_key(), &token)?;
            reserved
                .binding
                .control(self.secrets.load(&reserved.secret_key())?)?;
            Ok(())
        })
    }
    pub fn dispatch(&self, expected: &Record) -> journal::Result<(Record, DispatchPermit)> {
        let mut journal = self.journal()?;
        let record = journal.current(expected)?;
        record
            .binding
            .control(self.secrets.load(&record.secret_key())?)?;
        journal.dispatch(&record)
    }
    pub fn original(&self, expected: &Record) -> journal::Result<(Record, Control)> {
        let record = self.journal()?.current(expected)?;
        if record.stage != Stage::Dispatched {
            return Err(journal::Error::NotDispatched);
        }
        let control = record
            .binding
            .control(self.secrets.load(&record.secret_key())?)?;
        Ok((record, control))
    }
    pub fn release(
        &self,
        expected: &Record,
        discard_backup: bool,
    ) -> journal::Result<(Record, Control)> {
        let (record, control) = self.original(expected)?;
        Ok((self.journal()?.release(&record, discard_backup)?, control))
    }
    pub fn finalize(&self, expected: &Record) -> journal::Result<()> {
        let retired = self.journal()?.retire(expected)?;
        // Failure/crash here preserves the terminal retirement record for an explicit retry.
        self.journal()?.forget_retired(&retired, || {
            self.secrets
                .forget(&retired.secret_key(), &retired.binding.token_sha256)
        })
    }
}
