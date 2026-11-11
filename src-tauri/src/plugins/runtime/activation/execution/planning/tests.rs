use super::*;
use crate::{
    db::Database,
    plugins::{manifest, security, PluginStatus, PluginsManager},
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct Fixture {
    directory: PathBuf,
    db: Database,
    manager: Arc<PluginsManager>,
}

impl Fixture {
    fn new(packages: &[(&str, Value)]) -> Self {
        let directory =
            std::env::temp_dir().join(format!("tunnelde-graph-{}", uuid::Uuid::new_v4()));
        for (id, dependencies) in packages {
            let path = directory.join(id);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(
                path.join(manifest::MANIFEST_FILE),
                json!({
                    "id": id, "name": id, "version": "1.0.0", "apiVersion": 2,
                    "runtime": "declarative", "main": "view.json",
                    "views": [{"id":"main", "title": id}], "dependencies": dependencies,
                })
                .to_string(),
            )
            .unwrap();
            std::fs::write(path.join("view.json"), "{}").unwrap();
        }
        let manager = Arc::new(PluginsManager::load(directory.clone()));
        let db = Database::in_memory().unwrap();
        for (id, _) in packages {
            let fingerprint = security::fingerprint(&directory.join(id)).unwrap();
            manager
                .security
                .set_permissions(&db, id, fingerprint, &[], Some(vec![]))
                .unwrap();
        }
        Self {
            directory,
            db,
            manager,
        }
    }

    fn diamond() -> Self {
        Self::new(&[
            (
                "root",
                json!([{"id":"left","version":"^1"},{"id":"right","version":"^1"}]),
            ),
            ("left", json!([{"id":"shared","version":"^1"}])),
            ("right", json!([{"id":"shared","version":"^1"}])),
            ("shared", json!([])),
        ])
    }

    fn permit(&self) -> StartPermit {
        let fingerprint = self.manager.snapshots.read().unwrap()["root"]
            .fingerprint
            .clone();
        let plan = self.manager.activation_plan("root", &fingerprint).unwrap();
        let reviewed = plan
            .packages
            .iter()
            .map(|info| crate::plugins::PackageReview {
                id: info.id.clone(),
                fingerprint: info.fingerprint.clone(),
            })
            .collect::<Vec<_>>();
        self.manager
            .prepare_reviewed_start("root", &fingerprint, &reviewed)
            .unwrap()
    }

    fn stopped(&self) {
        for info in self.manager.snapshots.read().unwrap().values() {
            assert_eq!(info.status, PluginStatus::Stopped);
            assert!(info.runtime_id.is_none());
            let lease = self
                .manager
                .security
                .lease(&info.id, info.fingerprint.clone(), info.permissions.clone())
                .unwrap();
            assert_eq!(
                self.manager
                    .security
                    .is_ready(&lease)
                    .unwrap_err()
                    .to_string(),
                "plugin.notRunning"
            );
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn installed_diamond_captures_original_grants_and_exact_direct_edges() {
    let f = Fixture::diamond();
    let permit = f.permit();
    let plan = f.manager.admit_graph("root", &permit).unwrap();
    assert_eq!(
        plan.packages
            .iter()
            .map(|p| p.lease.id.as_str())
            .collect::<Vec<_>>(),
        ["shared", "left", "right", "root"]
    );
    assert_eq!(
        plan.packages[3]
            .required
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["left", "right"]
    );
    assert_eq!(
        plan.packages[1].required,
        vec![plan.packages[0].lease.clone()]
    );
    assert_eq!(
        plan.packages[2].required,
        vec![plan.packages[0].lease.clone()]
    );
    assert_eq!(permit.packages.len(), 3);
    f.stopped();
}

#[test]
fn review_projects_consent_identity_without_large_or_internal_catalogue_fields() {
    let f = Fixture::diamond();
    let fingerprint = f.manager.snapshots.read().unwrap()["root"]
        .fingerprint
        .clone();
    f.manager
        .snapshots
        .write()
        .unwrap()
        .get_mut("root")
        .unwrap()
        .readme = Some("content".repeat(100_000));
    let review = f.manager.activation_plan("root", &fingerprint).unwrap();
    let payload = serde_json::to_value(review).unwrap();
    assert_eq!(payload["packages"][3]["id"], "root");
    assert_eq!(payload["packages"][3]["fingerprint"], fingerprint);
    for package in payload["packages"].as_array().unwrap() {
        for field in [
            "readme",
            "commands",
            "views",
            "configuration",
            "packageManifest",
            "runtimeId",
        ] {
            assert!(
                package.get(field).is_none(),
                "unexpected review field: {field}"
            );
        }
    }
    assert!(serde_json::to_vec(&payload).unwrap().len() < 16_384);
}

#[test]
fn stale_or_reordered_dependency_grants_cannot_be_borrowed() {
    let f = Fixture::diamond();
    let mut reordered = f.permit();
    reordered.packages.swap(0, 1);
    assert!(f.manager.admit_graph("root", &reordered).is_err());
    let permit = f.permit();
    f.manager.security.retire_runtime("shared");
    assert!(f.manager.admit_graph("root", &permit).is_err());
    assert!(f.manager.admit_graph("root", &f.permit()).is_ok());
    f.stopped();
}

#[test]
fn only_the_exact_reviewed_graph_can_capture_dependency_approvals() {
    let f = Fixture::diamond();
    let fingerprint = f.manager.snapshots.read().unwrap()["root"]
        .fingerprint
        .clone();
    assert!(f.manager.prepare_start("root", &fingerprint).is_err());
    let plan = f.manager.activation_plan("root", &fingerprint).unwrap();
    let reviewed = plan
        .packages
        .iter()
        .map(|info| crate::plugins::PackageReview {
            id: info.id.clone(),
            fingerprint: info.fingerprint.clone(),
        })
        .collect::<Vec<_>>();
    assert!(f
        .manager
        .prepare_reviewed_start("root", &fingerprint, &reviewed)
        .is_ok());
    for changed in [
        reviewed[..3].to_vec(),
        {
            let mut changed = reviewed.clone();
            changed.swap(0, 1);
            changed
        },
        {
            let mut changed = reviewed.clone();
            changed[0].fingerprint = "0".repeat(64);
            changed
        },
        {
            let mut changed = reviewed.clone();
            changed[0].id = "other".into();
            changed
        },
    ] {
        assert!(f
            .manager
            .prepare_reviewed_start("root", &fingerprint, &changed)
            .is_err());
    }
    f.stopped();
}

#[test]
fn a_revoked_dependency_cannot_borrow_a_new_grant_from_a_previous_permit() {
    let f = Fixture::diamond();
    let old = f.permit();
    let fingerprint = f.manager.snapshots.read().unwrap()["shared"]
        .fingerprint
        .clone();
    f.manager
        .security
        .set_permissions(&f.db, "shared", fingerprint.clone(), &[], None)
        .unwrap();
    assert!(f.manager.admit_graph("root", &old).is_err());
    f.manager
        .security
        .set_permissions(&f.db, "shared", fingerprint, &[], Some(vec![]))
        .unwrap();
    assert!(f.manager.admit_graph("root", &old).is_err());
    assert!(f.manager.admit_graph("root", &f.permit()).is_ok());
    f.stopped();
}

#[test]
fn missing_dependency_approval_keeps_the_specific_package_context() {
    let f = Fixture::diamond();
    let fingerprint = f.manager.snapshots.read().unwrap()["shared"]
        .fingerprint
        .clone();
    f.manager
        .security
        .set_permissions(&f.db, "shared", fingerprint, &[], None)
        .unwrap();
    let fingerprint = f.manager.snapshots.read().unwrap()["root"]
        .fingerprint
        .clone();
    let plan = f.manager.activation_plan("root", &fingerprint).unwrap();
    let reviewed = plan
        .packages
        .iter()
        .map(|info| crate::plugins::PackageReview {
            id: info.id.clone(),
            fingerprint: info.fingerprint.clone(),
        })
        .collect::<Vec<_>>();
    let error = f
        .manager
        .prepare_reviewed_start("root", &fingerprint, &reviewed)
        .unwrap_err();
    let error = serde_json::to_value(error).unwrap();
    assert_eq!(error["message"], "pluginSecurity.approvalRequired");
    assert_eq!(error["details"]["activation"]["pluginId"], "shared");
    assert_eq!(error["details"]["activation"]["stage"], "approval");
    assert!(f
        .manager
        .snapshots
        .read()
        .unwrap()
        .values()
        .all(|info| info.status == PluginStatus::Stopped));
}

#[tokio::test]
async fn late_preflight_failure_leaves_every_engine_stopped_and_grants_intact() {
    let f = Fixture::diamond();
    let permit = f.permit();
    let plan = f.manager.admit_graph("root", &permit).unwrap();
    std::fs::write(f.directory.join("root/view.json"), "changed").unwrap();
    let error = f
        .manager
        .prepare_graph(plan, &f.db, &f.directory.join("runtimes"))
        .await
        .err()
        .unwrap();
    let error = serde_json::to_value(error).unwrap();
    assert_eq!(error["details"]["activation"]["pluginId"], "root");
    assert_eq!(error["details"]["activation"]["stage"], "preflight");
    f.stopped();
    std::fs::write(f.directory.join("root/view.json"), "{}").unwrap();
    let retry = f.manager.admit_graph("root", &permit).unwrap();
    assert_eq!(
        f.manager
            .prepare_graph(retry, &f.db, &f.directory.join("runtimes"))
            .await
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
async fn preflight_does_not_wait_for_a_shared_engine_instance_lock() {
    let f = Fixture::diamond();
    let shared = f.manager.instance("shared").await.unwrap();
    let _busy = shared.lock().await;
    let plan = f.manager.admit_graph("root", &f.permit()).unwrap();
    let runtimes = f.directory.join("runtimes");
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        f.manager.prepare_graph(plan, &f.db, &runtimes),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap().len(), 4);
    f.stopped();
}

#[tokio::test]
async fn root_cancellation_interrupts_preflight_queued_behind_package_mutation() {
    let f = Fixture::diamond();
    let plan = f.manager.admit_graph("root", &f.permit()).unwrap();
    let _writer = f.manager.mutations.write().await;
    let runtimes = f.directory.join("runtimes");
    let mut waiting = Box::pin(f.manager.prepare_graph(plan, &f.db, &runtimes));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    f.manager.security.retire_runtime("root");
    assert!(tokio::time::timeout(Duration::from_millis(200), waiting)
        .await
        .unwrap()
        .is_err());
    f.stopped();
}

#[test]
fn absent_dependency_reports_its_identity_and_chain_without_any_activation() {
    let f = Fixture::new(&[("root", json!([{"id":"missing","version":"^1"}]))]);
    let fingerprint = f.manager.snapshots.read().unwrap()["root"]
        .fingerprint
        .clone();
    let error = f.manager.activation_plan("root", &fingerprint).unwrap_err();
    let error = serde_json::to_value(error).unwrap();
    assert_eq!(error["message"], "plugin.activation.missingDependency");
    assert_eq!(error["details"]["id"], "missing");
    f.stopped();
}
