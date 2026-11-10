mod ownership;
mod revocation;

pub(super) use ownership::Owner;
pub(in crate::plugins) use revocation::revoke_before;
