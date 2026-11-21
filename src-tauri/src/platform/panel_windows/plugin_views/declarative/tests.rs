use super::{super::Target, Admission};
use crate::platform::panel_windows::ownership::Lease;
use crate::platform::panel_windows::ownership::Ownership;
use crate::plugins::security::Lease as PluginLease;
use serde_json::{json, Value};
fn setup() -> (Ownership, String, String, Lease) {
    let mut owner = Ownership::default();
    let main = owner.register("main").unwrap();
    let target = owner.register("target").unwrap();
    owner.ready("main", &main).unwrap();
    owner.ready("target", &target).unwrap();
    let lease = owner
        .add_panel("main", &main, "plugin:sample:files")
        .unwrap();
    (owner, main, target, lease)
}
fn plugin_lease() -> PluginLease {
    PluginLease {
        id: "sample".into(),
        fingerprint: "private-fingerprint".into(),
        permissions: vec!["ui.trusted".into()],
        generation: 4,
    }
}
#[test]
fn declarative_descriptor_is_separate_from_frontend_sources_and_exact_runtime_bound() {
    let (mut owner, main, target, lease) = setup();
    let (descriptor, changed) = owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    assert!(changed);
    assert_eq!(descriptor.renderer, "json");
    assert_eq!(descriptor.panel_id, lease.panel_id);
    assert!(owner.transferable(&lease.panel_id));
    assert!(owner
        .register_declarative_adapter(
            "target",
            &target,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .is_err());
    assert!(owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: false,
            },
        )
        .is_err());
    assert!(owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: PluginLease {
                    generation: 5,
                    ..plugin_lease()
                },
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .is_err());
    let wire = json!(owner.declarative_adapters()).to_string();
    for secret in ["private-fingerprint", "ui.trusted", &main, &target] {
        assert!(!wire.contains(secret));
    }
}
#[test]
fn declarative_secrets_are_zeroized_private_and_follow_the_exact_panel_lease() {
    let (mut owner, main, target, lease) = setup();
    owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    let owned = Target::Owned {
        lease: lease.clone(),
    };
    let now = std::time::Instant::now();
    assert_eq!(
        owner
            .read_declarative_secret("main", &main, &owned, "tool:token", now)
            .unwrap(),
        ""
    );
    owner
        .write_declarative_secret("main", &main, &owned, "tool:token", "private-secret".into())
        .unwrap();
    assert_eq!(
        owner
            .read_declarative_secret("main", &main, &owned, "tool:token", now)
            .unwrap(),
        "private-secret"
    );
    assert!(!json!(owner.declarative_adapters())
        .to_string()
        .contains("private-secret"));
    assert!(
        !json!(owner.panels.values().map(|p| &p.model).collect::<Vec<_>>())
            .to_string()
            .contains("private-secret")
    );
    let offer = owner
        .prepare("main", &main, &lease, "target", Value::Null, now)
        .unwrap();
    assert!(owner
        .write_declarative_secret(
            "target",
            &target,
            &Target::Staged {
                id: offer.id.clone()
            },
            "tool:token",
            "staged-write".into(),
        )
        .is_err());
    owner
        .acknowledge("target", &target, &offer.id, now)
        .unwrap();
    assert_eq!(
        owner
            .read_declarative_secret(
                "target",
                &target,
                &Target::Staged {
                    id: offer.id.clone()
                },
                "tool:token",
                now,
            )
            .unwrap(),
        "private-secret"
    );
    let moved = owner.commit("main", &main, &offer.id, now).unwrap();
    assert_eq!(
        owner
            .read_declarative_secret(
                "target",
                &target,
                &Target::Owned {
                    lease: moved.clone()
                },
                "tool:token",
                now
            )
            .unwrap(),
        "private-secret"
    );
    owner
        .write_declarative_secret(
            "target",
            &target,
            &Target::Owned {
                lease: moved.clone(),
            },
            "tool:token",
            String::new(),
        )
        .unwrap();
    assert_eq!(
        owner
            .read_declarative_secret(
                "target",
                &target,
                &Target::Owned { lease: moved },
                "tool:token",
                now,
            )
            .unwrap(),
        ""
    );
}

#[test]
fn declarative_secret_values_are_bounded_and_retired_with_the_adapter() {
    let (mut owner, main, _, lease) = setup();
    owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    let owned = Target::Owned {
        lease: lease.clone(),
    };
    assert!(owner
        .write_declarative_secret("main", &main, &owned, "", "x".into())
        .is_err());
    assert!(owner
        .write_declarative_secret("main", &main, &owned, "tool:token", "x".repeat(8193))
        .is_err());
    owner
        .write_declarative_secret("main", &main, &owned, "tool:token", "secret".into())
        .unwrap();
    assert!(owner.retire_declarative_adapters(|_, _| true));
    assert!(owner
        .read_declarative_secret(
            "main",
            &main,
            &owned,
            "tool:token",
            std::time::Instant::now()
        )
        .is_err());
}

#[test]
fn declarative_model_requires_exact_revision_and_retirement_clears_state() {
    let (mut owner, main, _, lease) = setup();
    let (descriptor, _) = owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    assert!(owner
        .begin_declarative_model("main", &main, &lease.panel_id, "old")
        .is_err());
    let publisher = owner
        .begin_declarative_model("main", &main, &lease.panel_id, &descriptor.revision)
        .unwrap();
    owner
        .publish_model(
            "main",
            &main,
            &lease.panel_id,
            &publisher,
            1,
            json!({"title":"x"}),
        )
        .unwrap();
    assert_eq!(
        owner.read_model("main", &main, &lease).unwrap(),
        json!({"title":"x"})
    );
    assert!(owner.retire_declarative_adapters(|_, _| true));
    let replacement = owner.leases().remove(0);
    assert_eq!(replacement.window_id, "main");
    assert_eq!(
        owner.read_model("main", &main, &replacement).unwrap(),
        Value::Null
    );
    assert!(!owner
        .declarative_adapters()
        .iter()
        .any(|adapter| { adapter.plugin_id == "sample" && adapter.generation == 4 }));
}
#[test]
fn staged_declarative_target_can_read_model_but_cannot_run_effects() {
    let (mut owner, main, target, lease) = setup();
    owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    let now = std::time::Instant::now();
    let offer = owner
        .prepare("main", &main, &lease, "target", Value::Null, now)
        .unwrap();
    owner
        .acknowledge("target", &target, &offer.id, now)
        .unwrap();
    let publisher = owner
        .begin_declarative_model(
            "main",
            &main,
            &lease.panel_id,
            &owner.declarative_adapters()[0].revision,
        )
        .unwrap();
    owner
        .publish_model(
            "main",
            &main,
            &lease.panel_id,
            &publisher,
            1,
            json!({"title":"x"}),
        )
        .unwrap();
    assert_eq!(
        owner
            .staged_model("target", &target, &offer.id, now)
            .unwrap(),
        json!({"title":"x"})
    );
    let committed = owner.commit("main", &main, &offer.id, now).unwrap();
    assert_eq!(committed.window_id, "target");
}

#[test]
fn declarative_removal_is_exact_and_does_not_touch_a_replacement_approval() {
    let (mut owner, main, _, lease) = setup();
    let (first, _) = owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: plugin_lease(),
                runtime_id: "runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    assert!(owner
        .unregister_declarative_adapter(
            "main",
            &main,
            &lease.panel_id,
            "runtime",
            3,
            &first.revision,
        )
        .is_err());
    assert!(owner
        .unregister_declarative_adapter(
            "main",
            &main,
            &lease.panel_id,
            "runtime",
            4,
            &first.revision,
        )
        .unwrap());
    assert!(!owner
        .unregister_declarative_adapter(
            "main",
            &main,
            &lease.panel_id,
            "runtime",
            4,
            &first.revision,
        )
        .unwrap());
    let (second, _) = owner
        .register_declarative_adapter(
            "main",
            &main,
            Admission {
                plugin: PluginLease {
                    generation: 5,
                    ..plugin_lease()
                },
                runtime_id: "next-runtime".into(),
                view_id: "files".into(),
                title: "Sample files".into(),
                allow_floating: true,
            },
        )
        .unwrap();
    assert!(owner
        .unregister_declarative_adapter(
            "main",
            &main,
            &lease.panel_id,
            "runtime",
            4,
            &first.revision,
        )
        .is_err());
    assert_eq!(owner.declarative_adapters()[0], second);
}
