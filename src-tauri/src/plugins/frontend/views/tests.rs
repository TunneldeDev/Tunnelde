use super::*;
use crate::plugins::{frontend::FrontendSnapshot, security::PluginSecurity};
use std::{collections::BTreeMap, sync::Arc};

struct Fixture {
    registry: Registry,
    security: Arc<PluginSecurity>,
    lease: Lease,
    token: String,
}
impl Fixture {
    fn new() -> Self {
        let db = crate::db::Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        let digest = "a".repeat(64);
        let permissions = vec!["ui.trusted".into()];
        security
            .set_permissions(
                &db,
                "module",
                digest.clone(),
                &permissions,
                Some(permissions.clone()),
            )
            .unwrap();
        let lease = security
            .lease("module", digest.clone(), permissions)
            .unwrap();
        let pending = security.begin_runtime(&lease, &[], true).unwrap();
        security.native_ready(&lease).unwrap();
        let registry = Registry::default();
        let (token, _) = registry
            .insert(
                lease.clone(),
                Self::snapshot(digest),
                |lease| authorized(&security, lease),
                |lease, token| security.frontend_opened(lease, token).map(|_| ()),
            )
            .unwrap();
        security.frontend_ready(&lease, &token).unwrap();
        pending.commit();
        Self {
            registry,
            security,
            lease,
            token,
        }
    }
    fn snapshot(digest: String) -> FrontendSnapshot {
        FrontendSnapshot {
            directories: Default::default(),
            digest,
            assets: BTreeMap::from([("index.mjs".into(), Arc::from(b"approved".as_slice()))]),
            bytes: 8,
        }
    }
    fn open(&self, instance: uuid::Uuid) -> String {
        self.registry
            .open_view(&self.token, instance, "main", |lease| {
                authorized(&self.security, lease)
            })
            .unwrap()
            .0
    }
    fn close(&self, token: &str) -> (Vec<String>, Vec<RuntimeRetirement>) {
        self.registry.close(token, |lease, token| {
            self.security.frontend_closed(lease, token)
        })
    }
}

#[test]
fn independent_views_share_assets_without_replacing_activation_or_changing_readiness() {
    let f = Fixture::new();
    let first = f.open(uuid::Uuid::new_v4());
    let second = f.open(uuid::Uuid::new_v4());
    let modules = f.registry.modules.lock().unwrap();
    assert!(Arc::ptr_eq(
        &modules[&first].assets,
        &modules[&f.token].assets
    ));
    assert!(Arc::ptr_eq(
        &modules[&second].assets,
        &modules[&f.token].assets
    ));
    assert_eq!(
        modules.values().map(|module| module.bytes).sum::<usize>(),
        8
    );
    drop(modules);
    f.registry.calls.reserve(&first, "work").unwrap();
    f.registry.calls.reserve(&second, "other").unwrap();
    // Views cannot become activation/dependency readiness authorities.
    assert!(f.registry.with_activation(&first, |_| Ok(())).is_err());
    assert!(f
        .registry
        .open_view(&first, uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .is_err());
    assert!(f.security.is_ready(&f.lease).unwrap());
    assert_eq!(f.close(&first).0.as_slice(), std::slice::from_ref(&first));
    assert!(f.registry.calls.claim(&first, "work").is_err());
    assert!(f.registry.calls.claim(&second, "other").is_ok());
    assert!(f.registry.lease(&f.token).is_ok());
    assert!(f.registry.lease(&second).is_ok());
    assert!(f.security.is_ready(&f.lease).unwrap());
}

#[test]
fn reopening_one_instance_retires_only_that_view_and_never_retargets_it() {
    let f = Fixture::new();
    let instance = uuid::Uuid::new_v4();
    let first = f.open(instance);
    let unrelated = f.open(uuid::Uuid::new_v4());
    f.registry.calls.reserve(&first, "pending").unwrap();
    assert!(f
        .registry
        .open_view(&f.token, instance, "another", |_| Ok(()))
        .is_err());
    assert!(f.registry.lease(&first).is_ok());
    let (new, retired) = f
        .registry
        .open_view(&f.token, instance, "main", |_| Ok(()))
        .unwrap();
    assert_eq!(retired.as_slice(), std::slice::from_ref(&first));
    assert!(f.registry.calls.claim(&first, "pending").is_err());
    f.close(&first); // stale close cannot affect current instance
    assert!(f.registry.lease(&new).is_ok());
    assert!(f.registry.lease(&unrelated).is_ok());
    assert!(f.security.is_ready(&f.lease).unwrap());
}

#[test]
fn closing_activation_cascades_to_views_and_requests_but_not_other_activations() {
    let f = Fixture::new();
    let view = f.open(uuid::Uuid::new_v4());
    f.registry.calls.reserve(&view, "work").unwrap();
    let (tokens, retired) = f.close(&f.token);
    assert_eq!(tokens.len(), 2);
    assert!(tokens.contains(&view));
    assert!(retired.is_empty());
    assert!(f.registry.calls.claim(&view, "work").is_err());
    assert!(f.registry.lease(&view).is_err());
    assert!(!f.security.is_ready(&f.lease).unwrap());
    assert!(f.close(&f.token).0.is_empty());
}

#[test]
fn replacing_activation_and_shutdown_retire_all_views_without_promoting_them() {
    let f = Fixture::new();
    let view = f.open(uuid::Uuid::new_v4());
    f.registry.calls.reserve(&view, "pending").unwrap();
    let (token, retired) = f
        .registry
        .insert(
            f.lease.clone(),
            Fixture::snapshot(f.lease.fingerprint.clone()),
            |lease| authorized(&f.security, lease),
            |lease, token| f.security.frontend_opened(lease, token).map(|_| ()),
        )
        .unwrap();
    assert!(retired.contains(&view));
    assert!(retired.contains(&f.token));
    assert!(f.registry.with_activation(&f.token, |_| Ok(())).is_err());
    assert!(f.registry.with_activation(&token, |_| Ok(())).is_ok());
    assert!(f.registry.calls.claim(&view, "pending").is_err());
    assert!(!f.security.is_ready(&f.lease).unwrap());
    assert!(f
        .registry
        .open_view(&view, uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .is_err());
    f.security.frontend_ready(&f.lease, &token).unwrap();
    let next = f
        .registry
        .open_view(&token, uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .unwrap()
        .0;
    let mut closed = Vec::new();
    let (tokens, _) = f.registry.drain(|lease, token| {
        closed.push(token.to_owned());
        f.security.frontend_closed(lease, token)
    });
    assert!(tokens.contains(&next));
    assert_eq!(closed, [token]);
}

#[test]
fn view_capacity_is_independent_bounded_and_recovers_and_failed_authority_keeps_old_view() {
    let f = Fixture::new();
    let instance = uuid::Uuid::new_v4();
    let first = f.open(instance);
    for _ in 1..16 {
        f.open(uuid::Uuid::new_v4());
    }
    assert!(f
        .registry
        .open_view(&f.token, uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .is_err());
    assert!(f
        .registry
        .open_view(&f.token, instance, "main", |_| Err(AppError::validation(
            "denied"
        )))
        .is_err());
    assert!(f.registry.lease(&first).is_ok());
    let replacement = f.open(instance); // replacement at capacity is permitted
    f.close(&replacement);
    f.open(uuid::Uuid::new_v4());
    assert!(f.registry.lease(&f.token).is_ok());
}

#[test]
fn view_open_and_close_never_retire_live_dependency_consumers() {
    let f = Fixture::new();
    let db = crate::db::Database::in_memory().unwrap();
    f.security
        .set_permissions(&db, "consumer", "b".repeat(64), &[], Some(vec![]))
        .unwrap();
    let consumer = f
        .security
        .lease("consumer", "b".repeat(64), vec![])
        .unwrap();
    let pending = f
        .security
        .begin_runtime(&consumer, std::slice::from_ref(&f.lease), false)
        .unwrap();
    f.security.native_ready(&consumer).unwrap();
    pending.commit();
    let view = f.open(uuid::Uuid::new_v4());
    assert!(f.close(&view).1.is_empty());
    assert!(f.security.is_ready(&consumer).unwrap());
    assert_eq!(
        f.close(&f.token)
            .1
            .iter()
            .map(|retired| retired.id.as_str())
            .collect::<Vec<_>>(),
        ["consumer"]
    );
    assert!(f.security.is_ready(&consumer).is_err());
}

#[test]
fn discovery_never_advertises_missing_satellite_authority() {
    let discovery: serde_json::Value =
        serde_json::from_str(include_str!("../../extensions.json")).unwrap();
    let views = &discovery["frontend"]["viewFactories"];
    assert_eq!(views["nativeWindows"], false);
    assert_eq!(views["contexts"], serde_json::json!(["coordinator"]));
    assert_eq!(views["maximumPerActivation"], MAX_PER_ACTIVATION);
    assert_eq!(views["maximumTotal"], MAX_TOTAL);
}

#[test]
fn global_view_capacity_does_not_consume_activation_capacity_or_other_owners() {
    let f = Fixture::new();
    let mut tokens = vec![f.token.clone()];
    for id in ["other-one", "other-two", "other-three", "other-four"] {
        let mut lease = f.lease.clone();
        lease.id = id.into();
        // Policy admission is covered separately; exercise registry bookkeeping
        // with distinct captured owners and approved immutable snapshots.
        tokens.push(
            f.registry
                .insert(
                    lease,
                    Fixture::snapshot(f.lease.fingerprint.clone()),
                    |_| Ok(()),
                    |_, _| Ok(()),
                )
                .unwrap()
                .0,
        );
    }
    let mut first = None;
    for token in &tokens[..4] {
        for _ in 0..MAX_PER_ACTIVATION {
            let view = f
                .registry
                .open_view(token, uuid::Uuid::new_v4(), "main", |_| Ok(()))
                .unwrap()
                .0;
            first.get_or_insert(view);
        }
    }
    assert!(f
        .registry
        .open_view(&tokens[4], uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .is_err());
    f.close(first.as_ref().unwrap());
    let unrelated = f
        .registry
        .open_view(&tokens[4], uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .unwrap()
        .0;
    f.close(&f.token);
    assert!(f.registry.lease(&unrelated).is_ok());
    assert!(f.registry.lease(&tokens[4]).is_ok());
}

#[tokio::test]
async fn closing_one_view_cancels_its_claimed_work_without_retiring_siblings_or_activation() {
    let f = Fixture::new();
    let view = f.open(uuid::Uuid::new_v4());
    let sibling = f.open(uuid::Uuid::new_v4());
    f.registry.calls.reserve(&view, "request").unwrap();
    let mut request = f.registry.calls.claim(&view, "request").unwrap();
    let work = tokio::spawn(async move {
        request
            .run(std::future::pending::<AppResult<serde_json::Value>>())
            .await
    });
    tokio::task::yield_now().await;
    f.close(&view);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), work)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(f.registry.lease(&sibling).is_ok());
    assert!(f.security.is_ready(&f.lease).unwrap());
}

#[test]
fn native_view_tokens_cannot_use_raw_frontend_calls_providers_or_singleton_authority() {
    let f = Fixture::new();
    let (token, _) = f
        .registry
        .open_scoped_view(&f.token, uuid::Uuid::new_v4(), "main", true, |lease| {
            authorized(&f.security, lease)
        })
        .unwrap();
    assert!(f.registry.is_native_view(&token));
    assert!(!f.registry.is_native_view(&f.token));
    assert!(f.registry.with_lease(&token, |_| Ok(())).is_err());
    assert!(f.registry.with_activation(&token, |_| Ok(())).is_err());
    assert!(f
        .registry
        .open_view(&token, uuid::Uuid::new_v4(), "main", |_| Ok(()))
        .is_err());
    let regular = f.open(uuid::Uuid::new_v4());
    assert!(f.registry.with_lease(&regular, |_| Ok(())).is_ok());
    assert!(f.registry.with_activation(&f.token, |_| Ok(())).is_ok());
    assert!(f.security.is_ready(&f.lease).unwrap());
    assert!(f.close(&token).1.is_empty());
    assert!(f.registry.lease(&regular).is_ok());
    assert!(f.security.is_ready(&f.lease).unwrap());
}
#[test]
fn staged_snapshot_policy_is_explicit_not_name_or_permission_inference() {
    for method in [
        "api.describe",
        "extensions.describe",
        "mounts.rules.get",
        "storage.get",
        "configuration.snapshot",
    ] {
        assert!(super::super::native::call_policy(method).is_some_and(|p| p.staged()));
    }
    for method in [
        "hosts.snapshot",
        "mounts.rules.get.extra",
        "mounts.rules.save",
        "mounts.groups.observe",
        "storage.set",
        "configuration.update",
        "mounts.dependencies.get",
        "files.local.list",
        "bus.observe",
        "secrets.get",
        "workspace.panels.moveToWindow",
        "api.describe.extra",
        "extensions.describe\0",
    ] {
        assert!(
            !super::super::native::call_policy(method).is_some_and(|p| p.staged()),
            "{method}"
        );
    }
}

#[test]
fn reusing_a_view_instance_cannot_change_its_native_or_coordinator_authority_class() {
    let f = Fixture::new();
    let instance = uuid::Uuid::new_v4();
    let native = f
        .registry
        .open_scoped_view(&f.token, instance, "main", true, |_| Ok(()))
        .unwrap()
        .0;
    assert!(f
        .registry
        .open_scoped_view(&f.token, instance, "main", false, |_| Ok(()))
        .is_err());
    assert!(f.registry.is_native_view(&native));
    assert!(f.registry.with_lease(&native, |_| Ok(())).is_err());
}
