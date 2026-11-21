use super::*;
use crate::platform::panel_windows::plugin_views::Target;
use serde_json::Value;

fn fixture() -> (Ownership, String, String, Lease) {
    let mut r = Ownership::default();
    let main = r.register("main").unwrap();
    let target = r.register("target").unwrap();
    r.ready("main", &main).unwrap();
    r.ready("target", &target).unwrap();
    let lease = r.add_panel("main", &main, "plugin:sample:files").unwrap();
    r.bind_native_view(
        ("main", &main),
        Target::Owned {
            lease: lease.clone(),
        },
        PluginLease {
            id: "sample".into(),
            fingerprint: "private".into(),
            generation: 1,
            permissions: vec!["ui.trusted".into(), "mounts.write".into()],
        },
        "files",
        "view".into(),
        Instant::now(),
    )
    .unwrap();
    (r, main, target, lease)
}
#[test]
fn picker_requires_exact_committed_document_and_token_and_can_start_once() {
    let (mut r, main, target, _) = fixture();
    for (w, d, t) in [
        ("target", &target, "view"),
        ("main", &main, "foreign"),
        ("main", &target, "view"),
    ] {
        assert!(r.begin_view_picker(w, d, t).is_err());
    }
    let id = r.begin_view_picker("main", &main, "view").unwrap();
    assert!(r.view_picker_owner("main", &main, "view", &id).is_ok());
    assert!(r.view_picker_owner("target", &target, "view", &id).is_err());
    assert!(r.view_picker_owner("main", &target, "view", &id).is_err());
    r.start_view_picker(&id).unwrap();
    assert!(r.start_view_picker(&id).is_err());
    assert!(r.begin_view_picker("main", &main, "view").is_err());
    r.end_view_picker(&id);
    assert!(r.view_picker_owner("main", &main, "view", &id).is_err());
    assert!(r.begin_view_picker("main", &main, "view").is_ok());
}
#[test]
fn picker_blocks_handoff_until_actual_callback_cleanup_and_staged_views_cannot_open() {
    let (mut r, main, target, lease) = fixture();
    let id = r.begin_view_picker("main", &main, "view").unwrap();
    assert!(r
        .prepare("main", &main, &lease, "target", Value::Null, Instant::now())
        .is_err());
    r.end_view_picker(&id);
    let offer = r
        .prepare("main", &main, &lease, "target", Value::Null, Instant::now())
        .unwrap();
    r.bind_native_view(
        ("target", &target),
        Target::Staged {
            id: offer.id.clone(),
        },
        PluginLease {
            id: "sample".into(),
            fingerprint: "private".into(),
            generation: 1,
            permissions: vec![],
        },
        "files",
        "staged".into(),
        Instant::now(),
    )
    .unwrap();
    assert!(r.begin_view_picker("target", &target, "staged").is_err());
}
#[test]
fn view_close_and_document_replacement_do_not_release_old_os_dialog_reservation() {
    let (mut r, main, _, _) = fixture();
    let id = r.begin_view_picker("main", &main, "view").unwrap();
    r.close_native_view("main", &main, "view").unwrap();
    assert!(r.view_picker_owner("main", &main, "view", &id).is_err());
    assert!(r.native_views.pickers.has_window("main"));
    let next = r.register("main").unwrap();
    r.ready("main", &next).unwrap();
    let replacement = r
        .leases()
        .into_iter()
        .find(|p| p.panel_id == "plugin:sample:files")
        .unwrap();
    let replacement_interaction = r.begin_interaction("main", &next, &replacement).unwrap();
    // Callback cleanup is cleanup-only: it may retire its old ticket but not
    // remove a replacement interaction or start a new OS dialog.
    r.end_view_picker(&id);
    assert!(!r.native_views.pickers.has_window("main"));
    assert!(r
        .require_interaction("main", &next, &replacement, &replacement_interaction)
        .is_ok());
    r.end_view_picker(&id);
    assert!(r
        .require_interaction("main", &next, &replacement, &replacement_interaction)
        .is_ok());
}

#[test]
fn retired_panel_does_not_make_its_picker_parent_an_empty_destroyable_window() {
    let (mut r, main, target, lease) = fixture();
    let now = Instant::now();
    let offer = r
        .prepare("main", &main, &lease, "target", Value::Null, now)
        .unwrap();
    r.acknowledge("target", &target, &offer.id, now).unwrap();
    let moved = r.commit("main", &main, &offer.id, now).unwrap();
    r.bind_native_view(
        ("target", &target),
        Target::Owned {
            lease: moved.clone(),
        },
        PluginLease {
            id: "sample".into(),
            fingerprint: "private".into(),
            generation: 1,
            permissions: vec![],
        },
        "files",
        "satellite".into(),
        now,
    )
    .unwrap();
    let id = r.begin_view_picker("target", &target, "satellite").unwrap();
    r.reset_plugin_panel(&lease.panel_id);
    assert!(r.leases().iter().all(|p| p.window_id != "target"));
    assert!(!r.can_destroy("target"));
    assert!(r.reserve_empty_close("target").is_err());
    assert!(r.begin_close("target", &target).is_err());
    assert!(r
        .view_picker_owner("target", &target, "satellite", &id)
        .is_err());
    r.end_view_picker(&id);
    assert!(r.reserve_empty_close("target").is_ok());
}
