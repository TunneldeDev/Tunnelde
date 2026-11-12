//! Durable admission and original-operation recovery; no automatic submit replay.
use super::{
    client::Client,
    contracts::operation::Prepared,
    journal::{self, Binding, Journal, Record, Stage},
    secrets::Secrets,
    transport::{self, Exchange},
};
use std::sync::Mutex;
use tokio::sync::Semaphore;

#[derive(Debug)]
pub(super) enum Error {
    Journal(journal::Error),
    Remote(transport::Failure),
}
impl From<journal::Error> for Error {
    fn from(error: journal::Error) -> Self {
        Self::Journal(error)
    }
}
impl From<transport::Failure> for Error {
    fn from(error: transport::Failure) -> Self {
        Self::Remote(error)
    }
}
pub(super) struct Service<S> {
    journal: Mutex<Journal>,
    secrets: S,
    requests: Semaphore,
}
impl<S: Secrets> Service<S> {
    pub fn new(journal: Journal, secrets: S) -> Self {
        Self {
            journal: Mutex::new(journal),
            secrets,
            requests: Semaphore::new(4),
        }
    }
    fn journal(&self) -> journal::Result<std::sync::MutexGuard<'_, Journal>> {
        self.journal.lock().map_err(|_| journal::Error::Unavailable)
    }
    pub fn records(&self) -> journal::Result<Vec<Record>> {
        self.journal()?.records()
    }
    pub fn reserve(&self, binding: Binding, prepared: &Prepared) -> journal::Result<Record> {
        if !binding.matches(&binding.authority, prepared) {
            return Err(journal::Error::Unrecognized);
        }
        let reserved = self.journal()?.reserve(binding)?;
        // No dispatch is possible through any of these crash/failure windows.
        self.secrets
            .create(&reserved.secret_key(), &prepared.control.token)?;
        let token = self.secrets.load(&reserved.secret_key())?;
        reserved.binding.control(token)?;
        self.journal()?.ready(&reserved)
    }
    pub async fn submit<T: Exchange>(
        &self,
        expected: &Record,
        prepared: &Prepared,
        client: &Client<T>,
        authorize: impl FnOnce(&Binding) -> journal::Result<()>,
    ) -> Result<Record, Error> {
        let _request = self
            .requests
            .try_acquire()
            .map_err(|_| journal::Error::Capacity)?;
        let (dispatched, permit) = {
            let mut journal = self.journal()?;
            let record = journal.current(expected)?;
            if !record.binding.matches(client.authority(), prepared) {
                return Err(journal::Error::Changed.into());
            }
            record
                .binding
                .control(self.secrets.load(&record.secret_key())?)?;
            // Host integration must check the original owner/generation and cancellation here.
            // No await exists between this final admission and the durable dispatch gate.
            authorize(&record.binding)?;
            journal.dispatch(&record)?
        };
        // Persisted unknown remains even if this future, delivery or process disappears.
        let receipt = client.submit(prepared, permit).await?;
        Ok(self.journal()?.observe(&dispatched, receipt)?)
    }
    pub async fn recover<T: Exchange>(
        &self,
        expected: &Record,
        client: &Client<T>,
        authorize: impl FnOnce(&Binding) -> journal::Result<()>,
    ) -> Result<Record, Error> {
        let _request = self
            .requests
            .try_acquire()
            .map_err(|_| journal::Error::Capacity)?;
        let record = self.journal()?.current(expected)?;
        if record.stage != Stage::Dispatched {
            return Err(journal::Error::NotDispatched.into());
        }
        if record.binding.authority != *client.authority() {
            return Err(journal::Error::Changed.into());
        }
        let control = record
            .binding
            .control(self.secrets.load(&record.secret_key())?)?;
        authorize(&record.binding)?;
        let observed = client.status(&control, record.observation.as_ref()).await?;
        // Not found is not proof of nonpublication. Keep the dispatched record intact.
        let receipt = observed.ok_or(transport::Failure {
            reason: transport::Reason::MissingOperation,
            dispatched: true,
        })?;
        Ok(self.journal()?.observe(&record, receipt)?)
    }
    pub async fn release<T: Exchange>(
        &self,
        expected: &Record,
        client: &Client<T>,
        discard_backup: bool,
        authorize: impl FnOnce(&Binding) -> journal::Result<()>,
    ) -> Result<Record, Error> {
        let _request = self
            .requests
            .try_acquire()
            .map_err(|_| journal::Error::Capacity)?;
        let record = self.journal()?.current(expected)?;
        if record.stage != Stage::Dispatched || record.binding.authority != *client.authority() {
            return Err(journal::Error::Changed.into());
        }
        let control = record
            .binding
            .control(self.secrets.load(&record.secret_key())?)?;
        authorize(&record.binding)?;
        let releasing = self.journal()?.release(&record, discard_backup)?;
        let receipt = releasing
            .observation
            .as_ref()
            .ok_or(journal::Error::Changed)?;
        let released = client.release(&control, receipt, discard_backup).await?;
        Ok(self.journal()?.observe(&releasing, released)?)
    }
}

#[cfg(test)]
mod tests;
