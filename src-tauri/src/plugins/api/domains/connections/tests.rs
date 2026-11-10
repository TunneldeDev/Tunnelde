use super::*;
use serde_json::json;

#[test]
fn plugin_session_wire_shape_is_explicit_and_preserves_existing_fields() {
    let session = crate::ssh::SessionInfo {
        id: "session".into(),
        host_id: "host".into(),
        title: "Example".into(),
        address: "example.test:22".into(),
        cols: 80,
        rows: 24,
        connected_at: 123,
        terminal: true,
        purpose: None,
    };
    assert_eq!(
        serde_json::to_value(PluginSession::from(session)).unwrap(),
        json!({"id":"session","hostId":"host","title":"Example", "address":"example.test:22", "cols":80,"rows":24,"connectedAt":123})
    );
}
