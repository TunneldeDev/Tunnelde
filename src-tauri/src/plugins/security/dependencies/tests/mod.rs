use std::sync::Arc;

use crate::db::Database;
use crate::plugins::security::{Lease, PluginSecurity};

mod authorization;
mod frontend;
mod lifecycle;
mod readiness;
mod revocation;

fn fixture() -> (Arc<PluginSecurity>, Database) {
    (
        Arc::new(PluginSecurity::default()),
        Database::in_memory().unwrap(),
    )
}

fn grant(security: &PluginSecurity, db: &Database, id: &str, permissions: &[&str]) -> Lease {
    let permissions: Vec<_> = permissions.iter().map(|value| (*value).into()).collect();
    security
        .set_permissions(
            db,
            id,
            "a".repeat(64),
            &permissions,
            Some(permissions.clone()),
        )
        .unwrap();
    security.lease(id, "a".repeat(64), permissions).unwrap()
}

fn allowed(security: &PluginSecurity, lease: &Lease) -> bool {
    security
        .authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )
        .is_ok()
}

fn ready(security: &Arc<PluginSecurity>, lease: &Lease, dependencies: &[Lease]) {
    let pending = security.begin_runtime(lease, dependencies, false).unwrap();
    security.native_ready(lease).unwrap();
    pending.commit();
}
