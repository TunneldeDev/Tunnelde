use super::*;
use serde_json::Value;

fn fixture() -> (Ownership, String, String, String, Lease, Resource) {
    let mut r = Ownership::default();
    let main = r.register(MAIN).unwrap();
    let target = r.register("target").unwrap();
    let other = r.register("other").unwrap();
    for (w, d) in [(MAIN, &main), ("target", &target), ("other", &other)] {
        r.ready(w, d).unwrap();
    }
    let lease = r.add_panel(MAIN, &main, "filePreview").unwrap();
    let resource = Resource {
        id: uuid::Uuid::new_v4().to_string(),
        ticket: uuid::Uuid::new_v4().to_string(),
    };
    r.publish_preview_resource(MAIN, &main, Some(resource.clone()))
        .unwrap();
    (r, main, target, other, lease, resource)
}

#[test]
fn staged_handle_promotes_without_reopening_and_previous_owner_loses_access() {
    let (mut r, main, target, _, lease, resource) = fixture();
    let now = Instant::now();
    let old = r
        .open_preview_handle(
            MAIN,
            &main,
            Target::Owned {
                lease: lease.clone(),
            },
            &resource.id,
            now,
        )
        .unwrap();
    let offer = r
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    let staged = r
        .open_preview_handle(
            "target",
            &target,
            Target::Staged {
                id: offer.id.clone(),
            },
            &resource.id,
            now,
        )
        .unwrap();
    assert_eq!(
        r.resolve_preview_handle("target", &staged, now).unwrap(),
        resource.ticket
    );
    assert!(r.resolve_preview_handle("other", &staged, now).is_err());
    r.acknowledge("target", &target, &offer.id, now).unwrap();
    let owned = r.commit(MAIN, &main, &offer.id, now).unwrap();
    assert_eq!(
        r.resolve_preview_handle("target", &staged, now).unwrap(),
        resource.ticket
    );
    assert!(r.resolve_preview_handle(MAIN, &old, now).is_err());
    assert!(r
        .open_preview_handle(
            MAIN,
            &main,
            Target::Owned { lease: owned },
            &resource.id,
            now
        )
        .is_err());
    r.close_preview_handle("target", &target, &staged).unwrap();
    assert!(r.resolve_preview_handle("target", &staged, now).is_err());
    assert_eq!(
        r.preview_resources
            .publisher
            .as_ref()
            .unwrap()
            .resource
            .ticket,
        resource.ticket
    );
}

#[test]
fn cancellation_reload_replacement_and_aba_never_revive_handles() {
    let (mut r, main, target, _, lease, resource) = fixture();
    let now = Instant::now();
    let offer = r
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    let staged = r
        .open_preview_handle(
            "target",
            &target,
            Target::Staged {
                id: offer.id.clone(),
            },
            &resource.id,
            now,
        )
        .unwrap();
    r.cancel(MAIN, &main, &offer.id).unwrap();
    assert!(r.resolve_preview_handle("target", &staged, now).is_err());
    let old = r
        .open_preview_handle(
            MAIN,
            &main,
            Target::Owned {
                lease: lease.clone(),
            },
            &resource.id,
            now,
        )
        .unwrap();
    assert!(!r
        .publish_preview_resource(MAIN, &main, Some(resource.clone()))
        .unwrap());
    assert!(r.resolve_preview_handle(MAIN, &old, now).is_ok());
    r.publish_preview_resource(MAIN, &main, None).unwrap();
    r.publish_preview_resource(MAIN, &main, Some(resource.clone()))
        .unwrap();
    assert!(r.resolve_preview_handle(MAIN, &old, now).is_err());
    let before_reload = r
        .open_preview_handle(MAIN, &main, Target::Owned { lease }, &resource.id, now)
        .unwrap();
    r.register(MAIN).unwrap();
    assert!(r.resolve_preview_handle(MAIN, &before_reload, now).is_err());
}

#[test]
fn target_is_exact_and_ticket_metadata_never_appears_in_snapshot() {
    let (mut r, main, target, other, lease, resource) = fixture();
    let now = Instant::now();
    assert!(r
        .publish_preview_resource("target", &target, Some(resource.clone()))
        .is_err());
    assert!(r
        .publish_preview_resource(
            MAIN,
            &main,
            Some(Resource {
                id: "bad".into(),
                ticket: resource.ticket.clone()
            })
        )
        .is_err());
    assert!(r
        .open_preview_handle(
            "other",
            &other,
            Target::Owned {
                lease: lease.clone()
            },
            &resource.id,
            now
        )
        .is_err());
    assert!(r
        .open_preview_handle(
            MAIN,
            &main,
            Target::Owned {
                lease: lease.clone()
            },
            "replacement",
            now
        )
        .is_err());
    let tasks = r.add_panel(MAIN, &main, "tasks").unwrap();
    assert!(r
        .open_preview_handle(
            MAIN,
            &main,
            Target::Owned { lease: tasks },
            &resource.id,
            now
        )
        .is_err());
    let handle = r
        .open_preview_handle(MAIN, &main, Target::Owned { lease }, &resource.id, now)
        .unwrap();
    assert!(r.close_preview_handle("other", &other, &handle).is_err());
    let snapshot = r
        .dispatch(
            "other",
            &other,
            super::super::protocol::Command::Snapshot {},
            now,
        )
        .unwrap()
        .to_string();
    for secret in [&resource.id, &resource.ticket, &handle] {
        assert!(!snapshot.contains(secret));
    }
}

#[test]
fn handle_capacity_is_bounded_and_expired_entries_are_reclaimed() {
    let (mut r, main, target, _, lease, resource) = fixture();
    let now = Instant::now();
    let offer = r
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    for _ in 0..MAX_HANDLES {
        r.open_preview_handle(
            "target",
            &target,
            Target::Staged {
                id: offer.id.clone(),
            },
            &resource.id,
            now,
        )
        .unwrap();
    }
    assert!(r
        .open_preview_handle(
            "target",
            &target,
            Target::Staged {
                id: offer.id.clone()
            },
            &resource.id,
            now
        )
        .is_err());
    r.cancel(MAIN, &main, &offer.id).unwrap();
    r.open_preview_handle(MAIN, &main, Target::Owned { lease }, &resource.id, now)
        .unwrap();
    assert_eq!(r.preview_resources.handles.len(), 1);
}
