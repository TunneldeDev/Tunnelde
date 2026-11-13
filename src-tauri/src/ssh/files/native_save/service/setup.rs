use super::*;
use crate::ssh::files::native_save::{
    contracts::authority::Authority,
    journal::{setup, Owner},
};

impl<S: Secrets + 'static> Service<S> {
    pub async fn enable_setups(&self) -> journal::Result<()> {
        self.blocking(|storage| storage.journal()?.enable_setups())
            .await
    }
    pub async fn reserve_setup(
        &self,
        owner: Owner,
        plan: setup::Plan,
    ) -> journal::Result<setup::Record> {
        self.blocking(move |storage| storage.journal()?.reserve_setup(owner, plan))
            .await
    }
    pub async fn dispatch_setup(
        &self,
        expected: &setup::Record,
    ) -> journal::Result<setup::Dispatched> {
        let expected = expected.clone();
        self.blocking(move |storage| storage.journal()?.dispatch_setup(&expected))
            .await
    }
    pub async fn complete_setup(
        &self,
        permit: setup::Dispatched,
        authority: Authority,
    ) -> journal::Result<setup::Record> {
        self.blocking(move |storage| storage.journal()?.complete_setup(permit, authority))
            .await
    }
}
