use super::*;
use crate::{platform::panel_windows::ownership::Ownership, plugins::security::Lease};
use serde_json::{json, Value};
use std::time::Instant;

fn source(generation: u64, runtime: &str, floating: bool) -> Source {
    Source::test_source(
        Lease {
            id: "sample".into(),
            generation,
            fingerprint: "private-fingerprint".into(),
            permissions: vec!["ui.trusted".into()],
        },
        runtime,
        "files",
        floating,
        "private-activation",
    )
}
fn setup() -> (Ownership, String, String) {
    let mut r = Ownership::default();
    let main = r.register("main").unwrap();
    let target = r.register("target").unwrap();
    r.ready("main", &main).unwrap();
    r.ready("target", &target).unwrap();
    r.add_panel("main", &main, "plugin:sample:files").unwrap();
    (r, main, target)
}
#[test]
fn prefix_is_not_approval_and_only_main_can_admit_an_exact_floating_contribution() {
    let (mut r, main, target) = setup();
    assert!(!r.transferable("plugin:sample:files"));
    assert!(r.transferable("tasks"));
    assert!(r
        .register_plugin_adapter("target", &target, source(4, "runtime", true))
        .is_err());
    assert!(r
        .register_plugin_adapter("main", "stale", source(4, "runtime", true))
        .is_err());
    assert!(r
        .register_plugin_adapter("main", &main, source(4, "runtime", false))
        .is_err());
    let mut unknown = source(4, "runtime", true);
    unknown.lease.id = "undeclared".into();
    assert!(r.register_plugin_adapter("main", &main, unknown).is_err());
    let (descriptor, changed) = r
        .register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    assert!(changed);
    assert!(r.transferable(&descriptor.panel_id));
    assert!(!r.transferable("plugin:sample:other"));
    assert!(
        !r.register_plugin_adapter("main", &main, source(4, "runtime", true))
            .unwrap()
            .1
    );
    assert!(r
        .register_plugin_adapter("main", &main, source(5, "new-runtime", true))
        .is_err());
    assert!(r
        .admit_plugin_adapter_open(&source(5, "new-runtime", true))
        .is_err());
    let serialized = json!(r.plugin_adapters());
    assert_eq!(
        serialized[0],
        json!({
            "panelId":"plugin:sample:files", "revision": descriptor.revision, "pluginId":"sample", "generation":4,
            "runtimeId":"runtime", "viewId":"files", "entry":"index.js",
            "sdkVersion": crate::plugins::frontend::UI_SDK_VERSION,
            "title":"Sample files", "allowFloating":true,
        })
    );
    let text = serialized.to_string();
    for secret in [
        "private-activation",
        "private-fingerprint",
        "ui.trusted",
        &main,
        &target,
    ] {
        assert!(!text.contains(secret));
    }
}
#[test]
fn retirement_cancels_handoff_and_erases_capsules_without_releasing_admitted_effects() {
    let (mut r, main, target) = setup();
    r.register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    let lease = r.leases().remove(0);
    r.checkpoint(
        "main",
        &main,
        &lease,
        1,
        json!({"privateDraft":"old-runtime"}),
    )
    .unwrap();
    let now = Instant::now();
    let offer = r
        .prepare("main", &main, &lease, "target", json!({"old":true}), now)
        .unwrap();
    r.acknowledge("target", &target, &offer.id, now).unwrap();
    assert!(!r.retire_plugin_adapters(|s| s.lease.generation < 4));
    assert!(r.retire_plugin_adapters(|s| s.lease.generation < 5));
    assert!(r.commit("main", &main, &offer.id, now).is_err());
    assert!(r.staged("target", &target, &offer.id, now).is_err());
    assert!(r.view("main", &main, &lease).is_err());
    let replacement = r.leases().remove(0);
    assert_ne!(lease.generation, replacement.generation);
    assert_eq!(r.view("main", &main, &replacement).unwrap(), Value::Null);
    r.register_plugin_adapter("main", &main, source(5, "next", true))
        .unwrap();
    r.relay_fence(&replacement.panel_id, "actual-effect", true)
        .unwrap();
    assert!(r.retire_plugin_adapters(|_| true));
    let replacement = r.leases().remove(0);
    assert!(r
        .register_plugin_adapter("main", &main, source(6, "replacement", true))
        .is_err());
    assert!(r
        .prepare("main", &main, &replacement, "target", Value::Null, now)
        .is_err());
    r.relay_fence(&replacement.panel_id, "actual-effect", false)
        .unwrap();
    assert!(r
        .prepare("main", &main, &replacement, "target", Value::Null, now)
        .is_ok());
}
#[test]
fn approved_satellite_lease_can_spawn_destinations_but_removed_panel_cannot_reuse_approval() {
    let (mut r, main, target) = setup();
    r.register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    let lease = r.leases().remove(0);
    let now = Instant::now();
    let offer = r
        .prepare("main", &main, &lease, "target", Value::Null, now)
        .unwrap();
    r.acknowledge("target", &target, &offer.id, now).unwrap();
    let lease = r.commit("main", &main, &offer.id, now).unwrap();
    assert!(r
        .authorize_creation("target", &target, Some(&lease))
        .is_ok());
    assert!(r.authorize_creation("main", &main, Some(&lease)).is_err());
    r.remove_panel("main", &main, &lease.panel_id).unwrap();
    r.add_panel("main", &main, &lease.panel_id).unwrap();
    assert!(r.plugin_adapters().is_empty());
    assert!(!r.transferable(&lease.panel_id));
}

#[test]
fn withdrawal_is_main_only_and_old_cleanup_cannot_withdraw_a_replacement_runtime() {
    let (mut r, main, target) = setup();
    let id = "plugin:sample:files";
    r.register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    let revision = r.plugin_adapters()[0].revision.clone();
    assert!(r
        .unregister_plugin_adapter("target", &target, id, "runtime", 4, &revision)
        .is_err());
    assert!(r
        .unregister_plugin_adapter("main", &main, id, "runtime", 3, &revision)
        .is_err());
    assert!(r
        .unregister_plugin_adapter("main", &main, id, "other", 4, &revision)
        .is_err());
    assert!(r.transferable(id));
    assert!(r
        .unregister_plugin_adapter("main", &main, id, "runtime", 4, &revision)
        .unwrap());
    assert!(!r
        .unregister_plugin_adapter("main", &main, id, "runtime", 4, &revision)
        .unwrap());
    r.register_plugin_adapter("main", &main, source(5, "new-runtime", true))
        .unwrap();
    assert!(r
        .unregister_plugin_adapter("main", &main, id, "runtime", 4, &revision)
        .is_err());
    assert_eq!(r.plugin_adapters()[0].view.generation, 5);
}

#[test]
fn a_reopened_singleton_module_cannot_reuse_approval_even_with_identical_public_metadata() {
    let (mut r, main, _) = setup();
    let old = source(4, "same-runtime", true);
    let reopened = Source::test_source(
        old.lease.clone(),
        "same-runtime",
        "files",
        true,
        "replacement-activation",
    );
    assert!(old.descriptor() == reopened.descriptor());
    assert!(!old.same_module(&reopened));
    let (first, _) = r.register_plugin_adapter("main", &main, old).unwrap();
    assert!(r
        .register_plugin_adapter("main", &main, reopened.clone())
        .is_err());
    assert!(r.admit_plugin_adapter_open(&reopened).is_err());
    assert!(r.retire_plugin_adapters(|source| !source.same_module(&reopened)));
    assert!(
        r.register_plugin_adapter("main", &main, reopened.clone())
            .unwrap()
            .1
    );
    assert!(r.admit_plugin_adapter_open(&reopened).is_ok());
    let second = r.plugin_adapters().remove(0);
    assert_ne!(first.revision, second.revision);
    assert!(r
        .unregister_plugin_adapter(
            "main",
            &main,
            &first.panel_id,
            &first.view.runtime_id,
            first.view.generation,
            &first.revision
        )
        .is_err());
    assert!(r
        .unregister_plugin_adapter(
            "main",
            &main,
            &second.panel_id,
            &second.view.runtime_id,
            second.view.generation,
            &second.revision
        )
        .unwrap());
}

#[tokio::test]
async fn accepted_presentation_fence_survives_retirement_but_exact_source_can_finalize_cleanup() {
    use crate::platform::panel_windows::presentation_jobs::PresentationOperation;
    let (mut r, main, target) = setup();
    r.register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    let lease = r.leases().remove(0);
    let metadata = |visible| {
        serde_json::from_value(json!({"presentation":"workspace",
        "visible":visible,"pinned":true,"bounds":null,"available":true,
        "presentations":["sidebar","workspace","floating"]}))
        .unwrap()
    };
    r.publish_presentation("main", &main, &lease, metadata(true))
        .unwrap();
    let now = Instant::now();
    let (id, mut reply) = r
        .submit_presentation(
            source(4, "runtime", true).lease,
            &lease.panel_id,
            PresentationOperation::Close,
            now,
        )
        .unwrap();
    r.claim_presentations("main", &main, now).unwrap();
    r.presentation_admission("main", &main, &id, now).unwrap();
    r.admit_presentation(&id);
    r.retire_plugin_adapters(|_| true);
    assert!(r
        .complete_presentation("main", &main, &id, metadata(false))
        .is_err());
    assert!(r
        .register_plugin_adapter("main", &main, source(5, "next", true))
        .is_err());
    assert!(matches!(
        reply.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert!(r.fail_presentation("target", &target, &id).is_err());
    r.fail_presentation("main", &main, &id).unwrap();
    assert!(reply.await.unwrap().is_err());
    assert!(r
        .register_plugin_adapter("main", &main, source(5, "next", true))
        .is_ok());
}
#[tokio::test]
async fn retirement_cancels_unadmitted_presentation_reservations_without_leaving_a_busy_panel() {
    use crate::platform::panel_windows::presentation_jobs::PresentationOperation;
    let (mut r, main, _) = setup();
    r.register_plugin_adapter("main", &main, source(4, "runtime", true))
        .unwrap();
    let lease = r.leases().remove(0);
    r.publish_presentation(
        "main",
        &main,
        &lease,
        serde_json::from_value(json!({
        "presentation":"workspace","visible":true,"pinned":true,"bounds":null,
        "available":true,"presentations":["sidebar","workspace","floating"]}))
        .unwrap(),
    )
    .unwrap();
    let (id, reply) = r
        .submit_presentation(
            source(4, "runtime", true).lease,
            &lease.panel_id,
            PresentationOperation::Close,
            Instant::now(),
        )
        .unwrap();
    r.retire_plugin_adapters(|_| true);
    assert!(reply.await.unwrap().is_err());
    assert!(r.fail_presentation("main", &main, &id).is_err());
    assert!(r
        .register_plugin_adapter("main", &main, source(5, "next", true))
        .is_ok());
}
