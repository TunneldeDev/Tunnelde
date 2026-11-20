use super::*;
use std::time::Instant;

fn fixture() -> (Ownership, String, String, String, Lease, impl Send) {
    let mut registry = Ownership::default();
    let main = registry.register(MAIN).unwrap();
    let target = registry.register("target").unwrap();
    let other = registry.register("other").unwrap();
    for (w, d) in [(MAIN, &main), ("target", &target), ("other", &other)] {
        registry.ready(w, d).unwrap();
    }
    let (endpoint, receiver) = Endpoint::testing(&uuid::Uuid::new_v4().to_string());
    let lease = registry.bind_terminal(MAIN, &main, endpoint).unwrap();
    (registry, main, target, other, lease, receiver)
}
#[tokio::test]
async fn only_main_binds_a_live_concrete_resource_not_an_arbitrary_prefixed_panel() {
    let (mut registry, main, target, _, lease, receiver) = fixture();
    assert!(registry.transferable(&lease.panel_id));
    let session = lease.panel_id.strip_prefix("terminal:").unwrap();
    let (replacement, _replacement_rx) = Endpoint::testing(session);
    assert!(registry
        .bind_terminal("target", &target, replacement.clone())
        .is_err());
    assert!(registry.bind_terminal(MAIN, &main, replacement).is_err());
    let original = registry.terminals.sources[&lease.panel_id].endpoint.clone();
    assert_eq!(
        registry.bind_terminal(MAIN, &main, original).unwrap(),
        lease
    );
    let id = format!("terminal:{}", uuid::Uuid::new_v4());
    registry.add_panel(MAIN, &main, &id).unwrap();
    assert!(!registry.transferable(&id));
    let (unbound, _rx) = Endpoint::testing(id.strip_prefix("terminal:").unwrap());
    assert!(registry.bind_terminal(MAIN, &main, unbound).is_err());
    drop(receiver);
    assert!(!registry.transferable(&lease.panel_id));
}
#[tokio::test]
async fn exact_document_and_generation_control_input_and_output_separately() {
    let (mut registry, main, target, other, lease, _receiver) = fixture();
    let source = registry.terminals.sources[&lease.panel_id].clone();
    let now = Instant::now();
    assert!(registry
        .terminal_current(MAIN, &main, &lease, &source, true)
        .is_ok());
    assert!(registry.begin_terminal("other", &other, &lease).is_err());
    let offer = registry
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    assert!(registry
        .terminal_current(MAIN, &main, &lease, &source, false)
        .is_ok());
    assert!(registry.begin_terminal(MAIN, &main, &lease).is_err());
    assert!(registry.begin_terminal("target", &target, &lease).is_err());
    registry
        .acknowledge("target", &target, &offer.id, now)
        .unwrap();
    let owned = registry.commit(MAIN, &main, &offer.id, now).unwrap();
    assert!(registry
        .terminal_current(MAIN, &main, &lease, &source, false)
        .is_err());
    assert!(registry.begin_terminal(MAIN, &main, &lease).is_err());
    assert!(registry
        .terminal_current("target", &target, &owned, &source, true)
        .is_ok());
    registry.register("target").unwrap();
    assert!(registry
        .terminal_current("target", &target, &owned, &source, false)
        .is_err());
}
#[tokio::test]
async fn queued_effects_hold_transfer_and_resource_removal_until_actual_settlement() {
    let (mut registry, main, _, _, lease, _receiver) = fixture();
    let (_, effect) = registry.begin_terminal(MAIN, &main, &lease).unwrap();
    assert!(registry
        .prepare(MAIN, &main, &lease, "target", Value::Null, Instant::now())
        .is_err());
    assert!(registry.remove_panel(MAIN, &main, &lease.panel_id).is_err());
    // Main document loss is not effect settlement and must not release its fence.
    let next = registry.register(MAIN).unwrap();
    assert!(registry.remove_panel(MAIN, &next, &lease.panel_id).is_err());
    registry.finish_native_action(&lease.panel_id, &effect);
    registry.remove_panel(MAIN, &next, &lease.panel_id).unwrap();
    assert!(!registry.terminals.sources.contains_key(&lease.panel_id));
}
#[tokio::test]
async fn same_resource_republication_after_main_reload_never_revives_old_source_authority() {
    let (mut registry, main, _, _, lease, _receiver) = fixture();
    let source = registry.terminals.sources[&lease.panel_id].clone();
    let next = registry.register(MAIN).unwrap();
    registry.ready(MAIN, &next).unwrap();
    assert!(!registry.terminal_registered(&lease.panel_id));
    let owned = registry
        .bind_terminal(MAIN, &next, source.endpoint.clone())
        .unwrap();
    assert!(registry
        .terminal_current(MAIN, &main, &lease, &source, false)
        .is_err());
    assert!(registry
        .terminal_current(MAIN, &next, &owned, &source, false)
        .is_err());
    let replacement = registry.terminals.sources[&lease.panel_id].clone();
    assert!(registry
        .terminal_current(MAIN, &next, &owned, &replacement, true)
        .is_ok());
    let snapshot = registry
        .dispatch(
            MAIN,
            &next,
            super::super::protocol::Command::Snapshot {},
            Instant::now(),
        )
        .unwrap();
    let text = serde_json::to_string(&snapshot).unwrap();
    assert!(!text.contains("endpoint"));
    assert!(!text.contains(&main));
    assert!(!text.contains(&next));
}
#[test]
fn grammar_rejects_arbitrary_ssh_selectors_and_unknown_operations() {
    for value in [
        json!({"action":"connect", "hostId":"x"}),
        json!({"action":"detach", "sessionId":"x"}),
        json!({"action":"bind", "sessionId":"x", "window":"main"}),
        json!({"action":"attach", "sessionId":"x", "output":"__CHANNEL__:1"}),
    ] {
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}
