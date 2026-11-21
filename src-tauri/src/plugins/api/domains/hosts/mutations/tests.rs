use super::*;
use crate::{db, services::hosts::test_service};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

mod contention;

#[derive(Default)]
struct Origin {
    retired: Mutex<bool>,
    attempts: AtomicUsize,
}
impl Authority for Origin {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        let retired = self.retired.lock().unwrap();
        if *retired {
            return Err(AppError::validation("origin.expired"));
        }
        self.attempts.fetch_add(1, Ordering::SeqCst);
        effect()
    }
}
struct Fixture {
    db: Database,
    security: Arc<PluginSecurity>,
    lease: Lease,
    origin: Arc<Origin>,
    events: Arc<Mutex<Vec<String>>>,
}
impl Fixture {
    fn new(permission: &str) -> Self {
        let db = Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        let digest = "a".repeat(64);
        let declared = vec![permission.to_owned()];
        security
            .set_permissions(
                &db,
                "editor",
                digest.clone(),
                &declared,
                Some(declared.clone()),
            )
            .unwrap();
        let lease = security.lease("editor", digest, declared).unwrap();
        Self {
            db,
            security,
            lease,
            origin: Arc::default(),
            events: Arc::default(),
        }
    }
    fn recorder(&self) -> Recorder {
        Recorder {
            db: self.db.clone(),
            security: self.security.clone(),
            lease: self.lease.clone(),
            origin: self.origin.clone(),
            events: self.events.clone(),
        }
    }
    fn execute(&self, method: &str, params: Value) -> AppResult<Value> {
        let (cancel, _pending) = Cancellation::for_test("cancelled");
        self.execute_checked(method, params, &cancel, Some(self.origin.as_ref()))
    }
    fn execute_checked(
        &self,
        method: &str,
        params: Value,
        cancel: &Cancellation,
        authority: Option<&dyn Authority>,
    ) -> AppResult<Value> {
        let service = test_service(&self.db, self.recorder()).admitted(Checked {
            db: &self.db,
            security: &self.security,
            lease: &self.lease,
            cancel,
            authority,
        });
        execute(&service, method, params)
    }
    fn state(&self) -> Value {
        json!({"snapshot": crate::services::hosts::snapshot(&self.db).unwrap(), "audit": self.audit()})
    }
    fn audit(&self) -> Vec<String> {
        self.db
            .with(|conn| {
                Ok(conn
                    .prepare("SELECT action FROM audit_log ORDER BY id")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap()
    }
    fn host(&self, name: &str) -> Value {
        self.execute("hosts.create", json!({"input": input(name)}))
            .unwrap()
    }
}
#[derive(Clone)]
struct Recorder {
    db: Database,
    security: Arc<PluginSecurity>,
    lease: Lease,
    origin: Arc<Origin>,
    events: Arc<Mutex<Vec<String>>>,
}
impl Recorder {
    fn record(&self, event: String) {
        // Publication must not hold origin, policy or DB: the real effects may
        // acquire SSH, credential cleanup or read-model owners themselves.
        assert!(self.origin.retired.try_lock().is_ok());
        self.security
            .authorize(
                &self.lease.id,
                &self.lease.fingerprint,
                &self.lease.permissions,
                None,
                None,
            )
            .unwrap();
        assert!(self.db.try_with(|_| Ok(())).unwrap().is_some());
        self.events.lock().unwrap().push(event);
    }
}
impl Effects for Recorder {
    fn renamed(&self, id: &str, name: &str) {
        assert_eq!(
            self.db
                .with(|conn| db::hosts::find_host(conn, id))
                .unwrap()
                .name,
            name
        );
        self.record(format!("rename:{id}:{name}"));
    }
    fn forget_credential(&self, id: &str) {
        assert!(self.db.with(|conn| db::hosts::find_host(conn, id)).is_err());
        self.record(format!("forget:{id}"));
    }
    fn changed(&self) {
        self.record("changed".into());
    }
}
fn input(name: &str) -> Value {
    json!({"name": name, "host":"192.0.2.1", "authMethod":"agent"})
}

#[test]
fn all_eight_methods_keep_domain_effects_and_wire_shapes_with_only_write_permission() {
    let f = Fixture::new("hosts.write");
    for method in [
        "hosts.create",
        "hosts.update",
        "hosts.delete",
        "hosts.markUsed",
        "hosts.reorder",
        "groups.create",
        "groups.update",
        "groups.delete",
    ] {
        let info = crate::plugins::api::method_info(method).unwrap();
        assert_eq!(info.permissions, &["hosts.write"]);
    }
    let group = f
        .execute("groups.create", json!({"input":{"name":"Parent"}}))
        .unwrap();
    let group_id = group["id"].as_str().unwrap();
    assert_eq!(group["name"], "Parent");
    assert!(group["sortOrder"].is_number());
    assert!(group.get("createdAt").is_some());
    let host = f
        .execute(
            "hosts.create",
            json!({"input":{"name":"First", "host":"192.0.2.1", "groupId": group_id}}),
        )
        .unwrap();
    let id = host["id"].as_str().unwrap();
    assert_eq!(host["groupId"], group_id);
    assert!(host.get("credential").is_none());
    assert!(host.get("password").is_none());
    let renamed = f
        .execute("hosts.update", json!({"id":id, "input":input("Second")}))
        .unwrap();
    assert_eq!(renamed["name"], "Second");
    assert_eq!(renamed["id"], id);
    assert_eq!(
        f.execute("hosts.markUsed", json!({"id":id})).unwrap(),
        Value::Null
    );
    assert_eq!(
        f.execute("hosts.reorder", json!({"ids":[id]})).unwrap(),
        Value::Null
    );
    assert!(crate::services::hosts::snapshot(&f.db).unwrap().hosts[0]
        .last_used_at
        .is_some());
    let renamed_group = f
        .execute(
            "groups.update",
            json!({"id":group_id,"input":{"name":"Renamed"}}),
        )
        .unwrap();
    assert_eq!(renamed_group["name"], "Renamed");
    assert_eq!(
        f.execute("groups.delete", json!({"id":group_id})).unwrap(),
        Value::Null
    );
    assert_eq!(
        f.execute("hosts.delete", json!({"id":id})).unwrap(),
        Value::Null
    );
    let snapshot = crate::services::hosts::snapshot(&f.db).unwrap();
    assert!(snapshot.groups.is_empty() && snapshot.hosts.is_empty());
    let events = f.events.lock().unwrap();
    assert_eq!(events.iter().filter(|e| e.as_str() == "changed").count(), 8);
    assert_eq!(
        events.iter().filter(|e| e.starts_with("rename:")).count(),
        1
    );
    assert!(events.contains(&format!("rename:{id}:Second")));
    assert!(events.contains(&format!("forget:{id}")));
    assert_eq!(f.audit(), ["host.create", "host.update", "host.delete"]);
}

#[test]
fn missing_write_grant_and_retired_origin_cannot_mutate_any_method() {
    for permission in ["hosts.read", "hosts.write"] {
        let f = Fixture::new(permission);
        let host =
            f.db.with(|conn| {
                db::hosts::create_host(
                    conn,
                    &serde_json::from_value::<crate::models::HostInput>(input("Seed"))?
                        .validate()?,
                )
            })
            .unwrap();
        let group =
            f.db.with(|conn| db::hosts::create_group(conn, "Seed", None))
                .unwrap();
        let before = f.state();
        *f.origin.retired.lock().unwrap() = permission == "hosts.write";
        for (method, params) in [
            ("hosts.create", json!({"input": input("Denied")})),
            (
                "hosts.update",
                json!({"id":host.id,"input":input("Denied")}),
            ),
            ("hosts.delete", json!({"id":host.id})),
            ("hosts.markUsed", json!({"id":host.id})),
            ("hosts.reorder", json!({"ids":[host.id]})),
            ("groups.create", json!({"input":{"name":"Denied"}})),
            (
                "groups.update",
                json!({"id":group.id,"input":{"name":"Denied"}}),
            ),
            ("groups.delete", json!({"id":group.id})),
        ] {
            let error = f.execute(method, params).unwrap_err().to_string();
            assert_eq!(
                error,
                if permission == "hosts.read" {
                    "pluginSecurity.permissionDenied"
                } else {
                    "origin.expired"
                },
                "{method}"
            );
            assert_eq!(f.state(), before, "{method}");
        }
        assert!(f.events.lock().unwrap().is_empty());
    }
}

#[test]
fn malformed_input_validation_and_domain_errors_never_publish_or_replay() {
    let f = Fixture::new("hosts.write");
    let before = f.state();
    for (method, params) in [
        ("hosts.create", json!({"input": input(" ")})),
        ("hosts.create", json!({"input": null})),
        (
            "hosts.update",
            json!({"id":"missing","input":input("Valid")}),
        ),
        ("hosts.delete", json!({"id":"missing"})),
        ("hosts.reorder", json!({"ids":vec!["missing";501]})),
        ("groups.create", json!({"input":{"name":" "}})),
        (
            "groups.create",
            json!({"input":{"name":"Valid","parentId":"missing"}}),
        ),
        (
            "groups.update",
            json!({"id":"missing","input":{"name":"Valid"}}),
        ),
        ("hosts.create.extra", json!({})),
    ] {
        assert!(f.execute(method, params).is_err(), "{method}");
        assert_eq!(f.state(), before, "{method}");
    }
    assert!(f.events.lock().unwrap().is_empty());
    let host = f.host("Keep");
    let before = f.state();
    f.events.lock().unwrap().clear();
    f.db.with(|conn| {
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,'{}',0)", [format!("route:{}",host["id"].as_str().unwrap())])?;
        conn.execute_batch("CREATE TRIGGER refuse_route_delete BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT,'test'); END;")?;
        Ok(())
    }).unwrap();
    let attempts = f.origin.attempts.load(Ordering::SeqCst);
    assert!(f.execute("hosts.delete", json!({"id":host["id"]})).is_err());
    assert_eq!(f.origin.attempts.load(Ordering::SeqCst), attempts + 1);
    assert_eq!(f.state(), before);
    assert!(f.events.lock().unwrap().is_empty());
}

#[test]
fn admitted_reorder_rollback_preserves_order_and_non_native_transport_uses_same_service() {
    let f = Fixture::new("hosts.write");
    let first = f.host("First");
    let second = f.host("Second");
    let before = f.state();
    f.events.lock().unwrap().clear();
    f.db.with(|conn| {
        conn.execute_batch("CREATE TRIGGER refuse_reorder BEFORE UPDATE OF sort_order ON hosts WHEN OLD.name='First' BEGIN SELECT RAISE(ABORT,'test'); END;")?;
        Ok(())
    }).unwrap();
    assert!(f
        .execute("hosts.reorder", json!({"ids":[second["id"],first["id"]]}))
        .is_err());
    assert_eq!(f.state(), before);
    assert!(f.events.lock().unwrap().is_empty());
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let result = f
        .execute_checked(
            "hosts.update",
            json!({"id":first["id"],"input":input("Ordinary")}),
            &cancel,
            None,
        )
        .unwrap();
    assert_eq!(result["name"], "Ordinary");
}

#[test]
fn replacement_runtime_cannot_reuse_an_earlier_host_write_lease() {
    let f = Fixture::new("hosts.write");
    let before = f.state();
    f.security.invalidate_runtime("editor");
    // The package and grant are still valid; only the originally captured
    // runtime generation has retired. A fresh caller is separately admitted.
    assert!(f
        .security
        .lease(
            "editor",
            f.lease.fingerprint.clone(),
            f.lease.permissions.clone()
        )
        .is_ok());
    assert_eq!(
        f.execute("hosts.create", json!({"input":input("Stale")}))
            .unwrap_err()
            .to_string(),
        "pluginSecurity.changed"
    );
    assert_eq!(f.state(), before);
    assert!(f.events.lock().unwrap().is_empty());
}
