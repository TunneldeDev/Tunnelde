//! Durable admission and original-operation recovery; no automatic submit replay.
use super::{
    client::Client,
    contracts::operation::Prepared,
    journal::{self, Binding, Journal, Record, Stage},
    secrets::Secrets,
    transport::{self, Exchange},
};
use std::sync::{Arc, Mutex};
mod mutation;
pub(super) use mutation::Worker as LegacyWorker;
mod storage;
use storage::Storage;
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
    storage: Arc<Storage<S>>,
    requests: Semaphore,
    io: Arc<Semaphore>,
    legacy_workers: Arc<Mutex<std::collections::HashSet<String>>>,
}
impl<S: Secrets + 'static> Service<S> {
    pub fn new(journal: Journal, secrets: S) -> Self {
        Self {
            storage: Arc::new(Storage::new(journal, secrets)),
            requests: Semaphore::new(4),
            io: Arc::new(Semaphore::new(4)),
            legacy_workers: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }
    async fn blocking<T: Send + 'static>(
        &self,
        action: impl FnOnce(&Storage<S>) -> journal::Result<T> + Send + 'static,
    ) -> journal::Result<T> {
        let permit = self
            .io
            .clone()
            .try_acquire_owned()
            .map_err(|_| journal::Error::Capacity)?;
        let storage = self.storage.clone();
        tokio::task::spawn_blocking(move || {
            // Actual queued/running IO owns capacity even when caller delivery disappears.
            let _permit = permit;
            action(&storage)
        })
        .await
        .map_err(|_| journal::Error::Unavailable)?
    }
    pub async fn records(&self) -> journal::Result<Vec<Record>> {
        self.blocking(|storage| storage.journal()?.records()).await
    }
    // New production writes stay disabled until bilateral durable admission and
    // installation consent are integrated. Recovery must not mint a new submit.
    #[cfg(test)]
    pub async fn reserve(&self, binding: Binding, prepared: &Prepared) -> journal::Result<Record> {
        if !binding.matches(&binding.authority, prepared) {
            return Err(journal::Error::Unrecognized);
        }
        let token = prepared.control.token.clone();
        self.blocking(move |storage| storage.reserve(binding, token))
            .await
    }
    pub async fn finalize(&self, expected: &Record) -> journal::Result<()> {
        let expected = expected.clone();
        self.blocking(move |storage| storage.finalize(&expected))
            .await
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
        if !expected.binding.matches(client.authority(), prepared) {
            return Err(journal::Error::Changed.into());
        }
        let expected = expected.clone();
        let (dispatched, permit) = self
            .blocking(move |storage| storage.dispatch(&expected))
            .await?;
        // Check owner/generation and arbitrate cancellation AFTER the disk checkpoint:
        // revocation during fsync must prevent network mutation as well.
        authorize(&dispatched.binding)?;
        // Persisted unknown remains even if this future, delivery or process disappears.
        let receipt = client.submit(prepared, permit).await?;
        Ok(self
            .blocking(move |storage| storage.journal()?.observe(&dispatched, receipt))
            .await?)
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
        let expected = expected.clone();
        let (record, control) = self
            .blocking(move |storage| storage.original(&expected))
            .await?;
        if record.stage != Stage::Dispatched {
            return Err(journal::Error::NotDispatched.into());
        }
        if record.binding.authority != *client.authority() {
            return Err(journal::Error::Changed.into());
        }
        authorize(&record.binding)?;
        let observed = client.status(&control, record.observation.as_ref()).await?;
        // Not found is not proof of nonpublication. Keep the dispatched record intact.
        let receipt = observed.ok_or(transport::Failure {
            reason: transport::Reason::MissingOperation,
            dispatched: true,
        })?;
        Ok(self
            .blocking(move |storage| storage.journal()?.observe(&record, receipt))
            .await?)
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
        if expected.binding.authority != *client.authority() {
            return Err(journal::Error::Changed.into());
        }
        let expected = expected.clone();
        let (releasing, control) = self
            .blocking(move |storage| storage.release(&expected, discard_backup))
            .await?;
        authorize(&releasing.binding)?;
        let receipt = releasing
            .observation
            .as_ref()
            .ok_or(journal::Error::Changed)?;
        let released = client.release(&control, receipt, discard_backup).await?;
        Ok(self
            .blocking(move |storage| storage.journal()?.observe(&releasing, released))
            .await?)
    }
}

#[cfg(test)]
mod tests;
