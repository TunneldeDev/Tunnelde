//! Legacy and native writers arbitrate in the same private SQLite transaction.
mod continuation;
mod extension;
mod model;
pub(super) mod persistence;
#[cfg(test)]
mod tests;

use super::{Error, Journal, Owner, Result};
pub(crate) use model::Kind;
pub(in super::super::super) use model::{Claim, Phase, Scope};

/// Only an actual successful dispatch transition can mint settlement authority.
/// Reading a historical claim never recreates this non-cloneable permit.
pub(in super::super::super) struct Dispatched {
    claim: Claim,
}
impl Dispatched {
    pub fn claim(&self) -> &Claim {
        &self.claim
    }
}
