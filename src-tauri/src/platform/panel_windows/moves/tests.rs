use super::*;
use serde_json::json;

struct Fixture {
    state: Ownership,
    main: String,
    source: String,
    target: String,
    lease: Lease,
    now: Instant,
}
fn owner() -> PluginLease {
    PluginLease {
        id: "move-plugin".into(),
        fingerprint: "a".repeat(64),
        permissions: vec!["workspace.write".into()],
        generation: 3,
    }
}
impl Fixture {
    fn new() -> Self {
        let mut state = Ownership::default();
        let main = state.register("main").unwrap();
        let source = state.register("source").unwrap();
        let target = state.register("target").unwrap();
        for (id, doc) in [("main", &main), ("source", &source), ("target", &target)] {
            state.ready(id, doc).unwrap();
        }
        let now = Instant::now();
        let lease = state.add_panel("main", &main, "tasks").unwrap();
        let offer = state
            .prepare("main", &main, &lease, "source", Value::Null, now)
            .unwrap();
        state
            .acknowledge("source", &source, &offer.id, now)
            .unwrap();
        let lease = state.commit("main", &main, &offer.id, now).unwrap();
        Self {
            state,
            main,
            source,
            target,
            lease,
            now,
        }
    }
    fn submit(&mut self) -> (String, MoveReply) {
        self.state
            .submit_move(
                owner(),
                "tasks",
                "target",
                Some(("source", self.lease.generation)),
                self.now,
            )
            .unwrap()
    }
    fn prepare(&mut self, id: &str) -> String {
        assert_eq!(
            self.state
                .claim_moves("source", &self.source, self.now, |_| Ok(()))
                .unwrap()
                .len(),
            1
        );
        self.state
            .prepare_move(
                "source",
                &self.source,
                id,
                json!({"privateDraft":"sentinel"}),
                self.now,
                |_| Ok(()),
            )
            .unwrap()
            .id
    }
}
#[test]
fn admission_is_exact_owner_ready_destination_and_interaction_fenced() {
    let mut f = Fixture::new();
    assert!(f
        .state
        .submit_move(
            owner(),
            "tasks",
            "target",
            Some(("main", f.lease.generation)),
            f.now
        )
        .is_err());
    assert!(f
        .state
        .submit_move(
            owner(),
            "tasks",
            "target",
            Some(("source", f.lease.generation + 1)),
            f.now
        )
        .is_err());
    assert!(f
        .state
        .submit_move(owner(), "tasks", "missing", None, f.now)
        .is_err());
    assert!(f
        .state
        .submit_move(owner(), "tasks", "source", None, f.now)
        .is_err());
    f.state.register("pending").unwrap();
    assert!(f
        .state
        .submit_move(owner(), "tasks", "pending", None, f.now)
        .is_err());
    f.state.add_panel("main", &f.main, "hosts").unwrap();
    assert!(f
        .state
        .submit_move(owner(), "hosts", "target", None, f.now)
        .is_err());
    let consent = f
        .state
        .begin_interaction("source", &f.source, &f.lease)
        .unwrap();
    assert!(f
        .state
        .submit_move(owner(), "tasks", "target", None, f.now)
        .is_err());
    f.state
        .end_interaction("source", &f.source, &f.lease, &consent)
        .unwrap();
    let (_id, _reply) = f.submit();
    assert!(f
        .state
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_err());
    assert!(f
        .state
        .submit_move(owner(), "tasks", "target", None, f.now)
        .is_err());
    assert!(f.state.begin_close("source", &f.source).is_err());
    assert!(f
        .state
        .issue_drag("source", &f.source, &f.lease, f.now)
        .is_err());
}
#[tokio::test]
async fn only_source_claims_once_and_commit_not_coordinator_cache_completes_reply() {
    let mut f = Fixture::new();
    let (id, mut reply) = f.submit();
    assert!(f
        .state
        .claim_moves("main", &f.main, f.now, |_| Ok(()))
        .unwrap()
        .is_empty());
    assert!(f
        .state
        .claim_moves("target", &f.target, f.now, |_| Ok(()))
        .unwrap()
        .is_empty());
    assert!(f
        .state
        .prepare_move("source", &f.source, &id, Value::Null, f.now, |_| Ok(()))
        .is_err());
    assert!(f.state.fail_move("target", &f.target, &id).is_err());
    assert!(f
        .state
        .claim_moves("source", "old-document", f.now, |_| Ok(()))
        .is_err());
    let jobs = f
        .state
        .claim_moves("source", &f.source, f.now, |_| Ok(()))
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].lease, f.lease);
    assert_eq!(jobs[0].target_window, "target");
    assert!(f
        .state
        .claim_moves("source", &f.source, f.now, |_| Ok(()))
        .unwrap()
        .is_empty());
    let offer = f
        .state
        .prepare_move(
            "source",
            &f.source,
            &id,
            json!({"draft":"only destination"}),
            f.now,
            |_| Ok(()),
        )
        .unwrap();
    assert!(f
        .state
        .prepare_move("source", &f.source, &id, Value::Null, f.now, |_| Ok(()))
        .is_err());
    assert!(reply.try_recv().is_err());
    assert!(f.state.commit("main", &f.main, &offer.id, f.now).is_err());
    f.state
        .acknowledge("target", &f.target, &offer.id, f.now)
        .unwrap();
    f.state
        .authorize_move_commit(&offer.id, f.now, |lease| {
            assert_eq!(lease.id, "move-plugin");
            Ok(())
        })
        .unwrap();
    let moved = f.state.commit("main", &f.main, &offer.id, f.now).unwrap();
    assert_eq!(moved.window_id, "target");
    assert_ne!(moved.generation, f.lease.generation);
    assert_eq!(reply.await.unwrap().unwrap(), moved);
    assert!(f.state.moves.is_empty());
    assert!(!f.state.cancel_move(&id, "late cancellation"));
    assert!(f.state.view("target", &f.target, &moved).is_ok());
}
#[tokio::test]
async fn queued_cancel_and_native_capture_failure_release_only_their_fence() {
    let mut f = Fixture::new();
    let (id, reply) = f.submit();
    assert!(f.state.cancel_move(&id, "cancelled"));
    assert_eq!(reply.await.unwrap().unwrap_err(), "cancelled");
    assert!(f
        .state
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
    assert!(f
        .state
        .claim_moves("source", &f.source, f.now, |_| Ok(()))
        .unwrap()
        .is_empty());
    let (id, reply) = f.submit();
    f.state
        .claim_moves("source", &f.source, f.now, |_| Ok(()))
        .unwrap();
    f.state.fail_move("source", &f.source, &id).unwrap();
    assert_eq!(
        reply.await.unwrap().unwrap_err(),
        "panel.window.sourceUnavailable"
    );
    assert!(f
        .state
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
}
#[tokio::test]
async fn policy_is_rechecked_at_claim_prepare_and_acknowledged_commit() {
    let mut f = Fixture::new();
    let (_id, reply) = f.submit();
    assert!(f
        .state
        .claim_moves("source", &f.source, f.now, |_| Err("revoked"))
        .unwrap()
        .is_empty());
    assert_eq!(reply.await.unwrap().unwrap_err(), "revoked");
    let (id, reply) = f.submit();
    f.state
        .claim_moves("source", &f.source, f.now, |_| Ok(()))
        .unwrap();
    assert!(f
        .state
        .prepare_move("source", &f.source, &id, Value::Null, f.now, |_| Err(
            "replaced"
        ))
        .is_err());
    assert_eq!(reply.await.unwrap().unwrap_err(), "replaced");
    let (id, reply) = f.submit();
    let offer = f.prepare(&id);
    f.state
        .acknowledge("target", &f.target, &offer, f.now)
        .unwrap();
    assert!(f
        .state
        .authorize_move_commit(&offer, f.now, |_| Err("revoked before commit"))
        .is_err());
    assert!(f.state.commit("main", &f.main, &offer, f.now).is_err());
    assert_eq!(reply.await.unwrap().unwrap_err(), "revoked before commit");
    assert!(f.state.view("source", &f.source, &f.lease).is_ok());
    assert!(f
        .state
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
}
#[tokio::test]
async fn caller_cancellation_cancels_prepared_transfer_before_ready_commit() {
    let mut f = Fixture::new();
    let (id, reply) = f.submit();
    let offer = f.prepare(&id);
    f.state
        .acknowledge("target", &f.target, &offer, f.now)
        .unwrap();
    drop(reply);
    assert!(!f.state.expire(f.now).is_empty());
    assert!(f
        .state
        .authorize_move_commit(&offer, f.now, |_| Ok(()))
        .is_ok());
    assert!(f.state.commit("main", &f.main, &offer, f.now).is_err());
    assert!(f.state.view("source", &f.source, &f.lease).is_ok());
    assert!(f.state.moves.is_empty());
}
#[tokio::test]
async fn source_or_destination_document_loss_retires_pending_moves_and_preserves_prepared_source_draft(
) {
    for target in [false, true] {
        for prepared in [false, true] {
            let mut f = Fixture::new();
            let (id, reply) = f.submit();
            if prepared {
                f.prepare(&id);
            }
            let window = if target { "target" } else { "source" };
            let document = f.state.register(window).unwrap();
            f.state.ready(window, &document).unwrap();
            assert_eq!(reply.await.unwrap().unwrap_err(), "stale window document");
            assert!(f.state.moves.is_empty());
            assert!(f.state.offers("main", &f.main).unwrap().is_empty());
            let lease = f
                .state
                .leases()
                .into_iter()
                .find(|l| l.panel_id == "tasks")
                .unwrap();
            assert_eq!(lease.window_id, "source");
            let source = if target { &f.source } else { &document };
            if prepared && !target {
                assert_eq!(
                    f.state.view("source", source, &lease).unwrap()["privateDraft"],
                    "sentinel"
                );
            }
            assert!(f
                .state
                .authorize_creation("source", source, Some(&lease))
                .is_ok());
        }
    }
}
#[tokio::test]
async fn deadline_native_transfer_cancel_and_panel_revocation_leave_no_orphaned_move() {
    for reason in [0, 1, 2, 3] {
        let mut f = Fixture::new();
        let (id, reply) = f.submit();
        let offer = if reason == 0 {
            None
        } else {
            Some(f.prepare(&id))
        };
        match reason {
            0 => {
                assert!(!f.state.expire(f.now + Duration::from_secs(26)).is_empty());
            }
            1 => {
                f.state
                    .cancel("target", &f.target, offer.as_ref().unwrap())
                    .unwrap();
            }
            2 => {
                f.state.block("main", &f.main, "tasks", true).unwrap();
            }
            _ => {
                f.state.remove_panel("main", &f.main, "tasks").unwrap();
            }
        }
        assert!(reply.await.unwrap().is_err());
        assert!(f.state.moves.is_empty());
        assert!(f.state.offers("main", &f.main).unwrap().is_empty());
    }
}
#[test]
fn move_ids_and_plugin_policy_do_not_enter_private_snapshot_or_public_model_fields() {
    let mut f = Fixture::new();
    let (id, _reply) = f.submit();
    let snapshot = f
        .state
        .dispatch(
            "main",
            &f.main,
            super::super::protocol::Command::Snapshot {},
            f.now,
        )
        .unwrap()
        .to_string();
    for secret in [id.as_str(), "move-plugin", &"a".repeat(64)] {
        assert!(!snapshot.contains(secret));
    }
}
