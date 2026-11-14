//! One live save owns all receipt writes, including a concurrent cancel response.
use super::*;
use crate::ssh::files::native_save::{
    client::follows,
    contracts::{operation::Control, receipt::Observation},
};
use std::{collections::HashMap, future::Future};
use tokio::sync::watch;

pub(super) type Registry = Arc<Mutex<HashMap<String, Arc<Active>>>>;
pub(super) struct Active {
    binding: Binding,
    requested: watch::Sender<bool>,
}
pub(in crate::ssh::files::native_save) struct Worker {
    active: Arc<Active>,
    registry: Registry,
}
impl Worker {
    pub fn cancellation(&self) -> Cancellation {
        Cancellation {
            binding: self.active.binding.clone(),
            requested: self.active.requested.subscribe(),
            sent: false,
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        let id = &self.active.binding.operation_id;
        if registry
            .get(id)
            .is_some_and(|active| Arc::ptr_eq(active, &self.active))
        {
            registry.remove(id);
        }
    }
}
pub(in crate::ssh::files::native_save) struct Cancellation {
    binding: Binding,
    requested: watch::Receiver<bool>,
    sent: bool,
}
impl Cancellation {
    fn unsent(&self) -> bool {
        !self.sent && *self.requested.borrow()
    }
    async fn wait(&mut self) {
        if self.sent {
            std::future::pending::<()>().await;
        }
        let _ = self.requested.wait_for(|requested| *requested).await;
        self.sent = true;
    }
}
impl<S: Secrets + 'static> Service<S> {
    pub fn observe_save(&self, binding: &Binding) -> journal::Result<Worker> {
        let mut registry = self.saves.lock().unwrap_or_else(|e| e.into_inner());
        if registry.contains_key(&binding.operation_id) {
            return Err(journal::Error::Changed);
        }
        let active = Arc::new(Active {
            binding: binding.clone(),
            requested: watch::channel(false).0,
        });
        registry.insert(binding.operation_id.clone(), active.clone());
        Ok(Worker {
            active,
            registry: self.saves.clone(),
        })
    }
    /// A historical receipt or a new connection cannot manufacture a live owner.
    pub fn save_status(&self, binding: &Binding) -> Option<bool> {
        self.saves
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&binding.operation_id)
            .filter(|active| active.binding == *binding)
            .map(|active| *active.requested.borrow())
    }
    pub fn request_save_cancel(&self, binding: &Binding) -> journal::Result<()> {
        let registry = self.saves.lock().unwrap_or_else(|e| e.into_inner());
        let active = registry
            .get(&binding.operation_id)
            .filter(|active| active.binding == *binding)
            .ok_or(journal::Error::Changed)?;
        active.requested.send_replace(true);
        Ok(())
    }
    pub async fn submit_cancellable<T: Exchange>(
        &self,
        expected: &Record,
        prepared: &Prepared,
        client: &Client<T>,
        authorize: impl FnOnce(&Binding) -> journal::Result<()>,
        cancellation: &mut Cancellation,
    ) -> Result<Record, Error> {
        if cancellation.binding != expected.binding {
            return Err(journal::Error::Changed.into());
        }
        if cancellation.unsent() {
            self.finalize(expected).await?;
            return Err(Error::Cancelled);
        }
        self.submit_inner(expected, prepared, client, authorize, Some(cancellation))
            .await
    }
    pub async fn recover_cancellable<T: Exchange>(
        &self,
        expected: &Record,
        client: &Client<T>,
        authorize: impl FnOnce(&Binding) -> journal::Result<()>,
        cancellation: &mut Cancellation,
    ) -> Result<Record, Error> {
        if cancellation.binding != expected.binding {
            return Err(journal::Error::Changed.into());
        }
        self.recover_inner(expected, client, authorize, Some(cancellation))
            .await
    }
}

pub(super) async fn exchange<T: Exchange>(
    client: &Client<T>,
    control: &Control,
    request: impl Future<Output = Result<Observation, transport::Failure>>,
    cancellation: Option<&mut Cancellation>,
) -> Result<Observation, transport::Failure> {
    let Some(cancellation) = cancellation else {
        return request.await;
    };
    // After the checkpoint, a cancel may precede submit. The official helper
    // records a cancellation tombstone for this exact control, never a new save.
    if cancellation.unsent() {
        cancellation.sent = true;
        return client.cancel(control).await;
    }
    tokio::pin!(request);
    tokio::select! {
        receipt = &mut request => receipt,
        () = cancellation.wait() => {
            // Drain the original exchange as well. Dropping it cannot establish
            // nonpublication; both replies belong to the same journal writer.
            let (original, cancelled) = tokio::join!(request, client.cancel(control));
            match (original, cancelled) {
                (Ok(old), Ok(new)) if follows(&old, &new) => Ok(new),
                (Ok(old), Ok(new)) if follows(&new, &old) => Ok(old),
                (Ok(_), Ok(_)) => Err(transport::Failure {
                    reason: transport::Reason::StaleReceipt, dispatched: true,
                }),
                (Err(_), Ok(receipt)) => Ok(receipt),
                (Ok(receipt), Err(_)) if receipt.releasable() => Ok(receipt),
                (_, Err(error)) => Err(error),
            }
        }
    }
}
