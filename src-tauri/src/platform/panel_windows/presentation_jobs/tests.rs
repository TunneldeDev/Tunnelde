use super::*;
use serde_json::json;
fn metadata(main: bool, visible: bool) -> LayoutMetadata {
    serde_json::from_value(json!({"presentation":"workspace","visible":visible,"pinned":true,"bounds":null,"available":true,"presentations":if main{vec!["sidebar","workspace","floating"]}else{vec!["workspace","floating"]}})).unwrap()
}
fn owner(id: &str) -> PluginLease {
    PluginLease {
        id: id.into(),
        fingerprint: "a".repeat(64),
        generation: 2,
        permissions: vec!["workspace.write".into()],
    }
}
struct Fixture {
    o: Ownership,
    main: String,
    source: String,
    lease: Lease,
    now: Instant,
}
impl Fixture {
    fn new() -> Self {
        let mut o = Ownership::default();
        let main = o.register("main").unwrap();
        let source = o.register("source").unwrap();
        o.ready("main", &main).unwrap();
        o.ready("source", &source).unwrap();
        let lease = o.add_panel("main", &main, "tasks").unwrap();
        let now = Instant::now();
        let offer = o
            .prepare("main", &main, &lease, "source", Value::Null, now)
            .unwrap();
        o.publish_staged_presentation("source", &source, &offer.id, metadata(false, true), now)
            .unwrap();
        o.acknowledge("source", &source, &offer.id, now).unwrap();
        let lease = o.commit("main", &main, &offer.id, now).unwrap();
        Self {
            o,
            main,
            source,
            lease,
            now,
        }
    }
    fn submit(&mut self) -> (String, oneshot::Receiver<Result<Value>>) {
        self.o
            .submit_presentation(owner("p"), "tasks", PresentationOperation::Close, self.now)
            .unwrap()
    }
    fn admit(&mut self, id: &str) {
        self.o
            .claim_presentations("source", &self.source, self.now)
            .unwrap();
        self.o
            .presentation_admission("source", &self.source, id, self.now)
            .unwrap();
        self.o.admit_presentation(id);
    }
}
#[tokio::test]
async fn only_real_source_claims_once_and_reply_waits_for_admitted_effect_completion() {
    let mut f = Fixture::new();
    let (id, mut reply) = f.submit();
    assert!(f
        .o
        .claim_presentations("main", &f.main, f.now)
        .unwrap()
        .is_empty());
    assert!(f
        .o
        .presentation_admission("source", &f.source, &id, f.now)
        .is_err());
    assert!(f
        .o
        .complete_presentation("source", &f.source, &id, metadata(false, false))
        .is_err());
    let jobs = f.o.claim_presentations("source", &f.source, f.now).unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].lease, f.lease);
    assert!(f
        .o
        .claim_presentations("source", &f.source, f.now)
        .unwrap()
        .is_empty());
    assert!(f
        .o
        .require_presentation_source("main", &f.main, &id)
        .is_err());
    assert!(f.o.fail_presentation("main", &f.main, &id).is_err());
    assert!(f.o.presentation_jobs.contains_key(&id));
    f.o.presentation_admission("source", &f.source, &id, f.now)
        .unwrap();
    f.o.admit_presentation(&id);
    assert!(reply.try_recv().is_err());
    f.o.complete_presentation("source", &f.source, &id, metadata(false, false))
        .unwrap();
    assert!(reply.await.unwrap().unwrap().is_null());
    assert_eq!(f.o.panel_metadata(&f.lease).unwrap()["visible"], false);
    assert!(f
        .o
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
}
#[tokio::test]
async fn admitted_effect_is_not_released_by_cancel_timeout_close_rollback_or_panel_reuse() {
    let mut f = Fixture::new();
    let (id, reply) = f.submit();
    f.admit(&id);
    drop(reply);
    assert!(!f.o.cancel_presentation(&id));
    f.o.expire(f.now + Duration::from_secs(90));
    assert!(f.o.presentation_jobs.contains_key(&id));
    assert!(f
        .o
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_err());
    assert!(f.o.begin_close("source", &f.source).is_err());
    f.o.cancel_close("source", &f.source).unwrap();
    assert!(f.o.presentation_jobs.contains_key(&id));
    assert!(f.o.remove_panel("main", &f.main, "tasks").is_err());
    f.o.block("main", &f.main, "tasks", true).unwrap();
    assert!(f.o.presentation_jobs.contains_key(&id));
    f.o.complete_presentation("source", &f.source, &id, metadata(false, false))
        .unwrap();
    f.o.block("main", &f.main, "tasks", false).unwrap();
    assert!(f
        .o
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
    f.o.remove_panel("main", &f.main, "tasks").unwrap();
}
#[tokio::test]
async fn queued_cancellation_and_expiry_report_invalidation_and_free_only_own_fence() {
    let mut f = Fixture::new();
    let (id, reply) = f.submit();
    assert!(f.o.cancel_presentation(&id));
    assert!(reply.await.unwrap().is_err());
    assert!(f
        .o
        .authorize_creation("source", &f.source, Some(&f.lease))
        .is_ok());
    let (id, reply) = f.submit();
    let expired = f.o.expire(f.now + Duration::from_secs(16));
    assert!(expired.contains(&id));
    assert!(reply.await.unwrap().is_err());
    let (_, reply) = f.submit();
    drop(reply);
    f.o.expire(f.now);
    assert!(f.o.presentation_jobs.is_empty());
}
#[tokio::test]
async fn exact_document_loss_cleans_accepted_effect_and_rejects_late_cleanup() {
    for crash in [false, true] {
        let mut f = Fixture::new();
        let (id, reply) = f.submit();
        f.admit(&id);
        f.o.register("other").unwrap();
        assert!(f.o.presentation_jobs.contains_key(&id));
        if crash {
            f.o.destroyed("source").unwrap();
        } else {
            f.o.register("source").unwrap();
        }
        assert!(reply.await.unwrap().is_err());
        assert!(f.o.presentation_jobs.is_empty());
        assert!(f
            .o
            .complete_presentation("source", &f.source, &id, metadata(false, false))
            .is_err());
        assert!(f.o.fail_presentation("source", &f.source, &id).is_err());
        let lease =
            f.o.leases()
                .into_iter()
                .find(|p| p.panel_id == "tasks")
                .unwrap();
        assert!(f.o.panel_metadata(&lease).is_err());
    }
}
#[test]
fn admission_rechecks_consent_and_supported_presentation_and_never_uses_main_cache() {
    let mut f = Fixture::new();
    assert!(f
        .o
        .submit_presentation(
            owner("p"),
            "tasks",
            PresentationOperation::Set {
                presentation: Presentation::Sidebar
            },
            f.now
        )
        .is_err());
    let guard =
        f.o.begin_interaction("source", &f.source, &f.lease)
            .unwrap();
    assert!(f
        .o
        .submit_presentation(owner("p"), "tasks", PresentationOperation::Close, f.now)
        .is_err());
    f.o.end_interaction("source", &f.source, &f.lease, &guard)
        .unwrap();
    let (id, _reply) = f.submit();
    f.o.claim_presentations("source", &f.source, f.now).unwrap();
    f.o.block("main", &f.main, "tasks", true).unwrap();
    assert!(f
        .o
        .presentation_admission("source", &f.source, &id, f.now)
        .is_err());
    f.o.fail_presentation("source", &f.source, &id).unwrap();
}
#[test]
fn queues_are_bounded_globally_and_by_plugin_and_metadata_is_not_a_job_dump() {
    let mut o = Ownership::default();
    let main = o.register("main").unwrap();
    o.ready("main", &main).unwrap();
    let now = Instant::now();
    let mut receivers = Vec::new();
    for i in 0..33 {
        let id = format!("plugin:p:v{i}");
        let lease = o.add_panel("main", &main, &id).unwrap();
        o.publish_presentation("main", &main, &lease, metadata(true, true))
            .unwrap();
        let result = o.submit_presentation(
            owner(&format!("p{}", i / 8)),
            &id,
            PresentationOperation::Close,
            now,
        );
        if i < 32 {
            receivers.push(result.unwrap().1);
        } else {
            assert!(result.is_err());
        }
    }
    assert_eq!(o.presentation_jobs.len(), 32);
    let lease = o.leases()[0].clone();
    assert!(!o
        .panel_metadata(&lease)
        .unwrap()
        .to_string()
        .contains("fingerprint"));
    let mut f = Fixture::new();
    for i in 0..9 {
        let id = format!("plugin:p:v{i}");
        let lease = f.o.add_panel("main", &f.main, &id).unwrap();
        f.o.publish_presentation("main", &f.main, &lease, metadata(true, true))
            .unwrap();
        let result =
            f.o.submit_presentation(owner("same"), &id, PresentationOperation::Close, f.now);
        if i < 8 {
            receivers.push(result.unwrap().1);
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
async fn set_returns_actual_source_metadata_and_mismatched_completion_does_not_commit() {
    let mut f = Fixture::new();
    let (id, mut reply) =
        f.o.submit_presentation(
            owner("p"),
            "tasks",
            PresentationOperation::Set {
                presentation: Presentation::Floating,
            },
            f.now,
        )
        .unwrap();
    f.admit(&id);
    assert!(f
        .o
        .complete_presentation("source", &f.source, &id, metadata(false, true))
        .is_err());
    assert!(reply.try_recv().is_err());
    assert!(f.o.presentation_jobs.contains_key(&id));
    let mut value = serde_json::to_value(metadata(false, true)).unwrap();
    value["presentation"] = json!("floating");
    f.o.complete_presentation(
        "source",
        &f.source,
        &id,
        serde_json::from_value(value).unwrap(),
    )
    .unwrap();
    let row = reply.await.unwrap().unwrap();
    assert_eq!(row["windowId"], "source");
    assert_eq!(row["presentation"], "floating");
    assert_eq!(row["visible"], true);
}

#[tokio::test]
async fn admission_rechecks_current_source_availability_and_supported_forms() {
    for unavailable in [false, true] {
        let mut f = Fixture::new();
        let (id, reply) =
            f.o.submit_presentation(
                owner("p"),
                "tasks",
                PresentationOperation::Set {
                    presentation: Presentation::Floating,
                },
                f.now,
            )
            .unwrap();
        f.o.claim_presentations("source", &f.source, f.now).unwrap();
        let mut changed = serde_json::to_value(metadata(false, false)).unwrap();
        if unavailable {
            changed["available"] = json!(false);
        } else {
            changed["presentations"] = json!(["workspace"]);
        }
        f.o.publish_presentation(
            "source",
            &f.source,
            &f.lease,
            serde_json::from_value(changed).unwrap(),
        )
        .unwrap();
        assert!(f
            .o
            .presentation_admission("source", &f.source, &id, f.now)
            .is_err());
        assert!(!f.o.presentation_jobs[&id].started);
        assert!(f.o.cancel_presentation(&id));
        assert!(reply.await.unwrap().is_err());
    }
}
