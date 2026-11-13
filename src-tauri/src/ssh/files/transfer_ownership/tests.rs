use super::*;

#[test]
fn empty_worker_ownership_is_not_retained_with_completed_results() {
    let mut state = TransferState::default();
    state.retain_ownership("empty", Shared::default());
    assert!(state.retained_ownership.is_empty());
}

#[test]
fn task_projection_cannot_switch_remote_hosts_or_become_local() {
    use native_save::runtime::TaskEndpoint;
    use preparation::projected_endpoint_matches as matches;
    let endpoint = TaskEndpoint {
        path: "/destination".into(),
        remote: Some(crate::ssh::session::SessionIdentity {
            host_id: "original".into(),
            address: "user@host:22".into(),
            server_key: "original-key".into(),
        }),
    };
    assert!(matches(
        &endpoint,
        Some("original"),
        Some("new-session"),
        Some("user@host:22")
    ));
    assert!(matches(
        &endpoint,
        Some("original"),
        Some("old-session"),
        None
    ));
    assert!(!matches(
        &endpoint,
        Some("other-host"),
        Some("new-session"),
        Some("user@host:22")
    ));
    assert!(!matches(
        &endpoint,
        Some("original"),
        None,
        Some("user@other-host:22")
    ));
    assert!(!matches(&endpoint, None, None, None));
    let local = TaskEndpoint {
        path: "C:/destination".into(),
        remote: None,
    };
    assert!(matches(&local, None, None, None));
    assert!(!matches(&local, None, Some("remote-session"), None));
    assert!(!matches(&local, Some("original"), None, None));
    assert!(!matches(&local, None, None, Some("user@host:22")));
}
