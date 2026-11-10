use std::collections::BTreeMap;

use super::super::{normalized, Lease};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Starting,
    AwaitingFrontend,
    Ready,
}

pub(super) struct Binding {
    pub lease: Lease,
    pub dependencies: Vec<Lease>,
    pub frontend: bool,
    pub phase: Phase,
    pub frontend_token: Option<String>,
}

impl Binding {
    pub(in crate::plugins::security) fn matches(&self, lease: &Lease) -> bool {
        self.lease.id == lease.id
            && self.lease.fingerprint == lease.fingerprint
            && self.lease.generation == lease.generation
            && self.lease.permissions == normalized(&lease.permissions)
    }
}

#[derive(Default)]
pub(in crate::plugins::security) struct RuntimeDependencies(pub(super) BTreeMap<String, Binding>);

impl RuntimeDependencies {
    pub(in crate::plugins::security) fn matches(&self, lease: &Lease) -> bool {
        self.0
            .get(&lease.id)
            .is_some_and(|binding| binding.matches(lease))
    }
}
