//! Closed, bounded resource-action relay to the singleton main document. Only
//! requests are queued, never callbacks or arbitrary application command names.
use super::ownership::{Lease, Ownership, MAIN};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
const QUEUE_TTL: Duration = Duration::from_secs(15);
const RESULT_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ViewAction {
    Task {
        key: String,
        ticket: String,
        action_id: String,
    },
    ClearTasks {},
    Disconnect {
        session_id: String,
    },
}
impl ViewAction {
    fn panel(&self) -> &'static str {
        match self {
            Self::Task { .. } | Self::ClearTasks {} => "tasks",
            Self::Disconnect { .. } => "connections",
        }
    }
    fn validate(&self) -> Result<(), &'static str> {
        let bounded = |s: &str, max| !s.is_empty() && s.len() <= max;
        let valid = match self {
            Self::Task {
                key,
                ticket,
                action_id,
            } => bounded(key, 1024) && bounded(ticket, 128) && bounded(action_id, 128),
            Self::Disconnect { session_id } => bounded(session_id, 128),
            Self::ClearTasks {} => true,
        };
        if valid {
            Ok(())
        } else {
            Err("invalid panel action")
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ActionResult {
    Done { value: Value },
    Failed { message: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionJob {
    pub id: String,
    pub lease: Lease,
    pub request: ViewAction,
}
pub(super) struct PendingAction {
    lease: Lease,
    source_document: String,
    coordinator_document: String,
    request: ViewAction,
    claimed: bool,
    result: Option<ActionResult>,
    deadline: Instant,
}
impl Ownership {
    pub fn request_action(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: ViewAction,
        now: Instant,
    ) -> Result<String, &'static str> {
        self.expire_actions(now);
        self.action(window, document, lease)?;
        request.validate()?;
        if request.panel() != lease.panel_id {
            return Err("wrong panel action");
        }
        if self.actions.len() >= 64
            || self
                .actions
                .values()
                .filter(|job| job.lease.panel_id == lease.panel_id && job.result.is_none())
                .count()
                >= 8
        {
            return Err("panel action limit");
        }
        let coordinator_document = self
            .document(MAIN)
            .ok_or("coordinator unavailable")?
            .to_owned();
        let id = uuid::Uuid::new_v4().to_string();
        self.relay_fence(&lease.panel_id, &id, true)?;
        self.actions.insert(
            id.clone(),
            PendingAction {
                lease: lease.clone(),
                source_document: document.into(),
                coordinator_document,
                request,
                claimed: false,
                result: None,
                deadline: now + QUEUE_TTL,
            },
        );
        Ok(id)
    }
    pub fn claim_actions(
        &mut self,
        window: &str,
        document: &str,
        now: Instant,
    ) -> Result<Vec<ActionJob>, &'static str> {
        self.main(window, document)?;
        self.expire_actions(now);
        let pending: Vec<_> = self
            .actions
            .iter()
            .filter(|(_, job)| !job.claimed && job.result.is_none())
            .map(|(id, job)| {
                (
                    id.clone(),
                    job.lease.clone(),
                    job.source_document.clone(),
                    job.coordinator_document.clone(),
                )
            })
            .collect();
        let mut jobs = Vec::new();
        for (id, lease, source, coordinator) in pending {
            if coordinator != document
                || self.action(&lease.window_id, &source, &lease).is_err()
                || self.relay_fence(&lease.panel_id, &id, true).is_err()
            {
                self.drop_action(&id);
                continue;
            }
            let entry = self.actions.get_mut(&id).unwrap();
            entry.claimed = true;
            jobs.push(ActionJob {
                id,
                lease,
                request: entry.request.clone(),
            });
        }
        Ok(jobs)
    }
    pub fn complete_action(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        result: ActionResult,
        now: Instant,
    ) -> Result<(), &'static str> {
        self.main(window, document)?;
        if serde_json::to_vec(&result)
            .map_err(|_| "invalid action result")?
            .len()
            > 64 * 1024
        {
            return Err("action result limit");
        }
        let job = self.actions.get_mut(id).ok_or("panel action expired")?;
        if !job.claimed || job.coordinator_document != document || job.result.is_some() {
            return Err("invalid action completion");
        }
        job.result = Some(result);
        job.deadline = now + RESULT_TTL;
        let panel = job.lease.panel_id.clone();
        self.relay_fence(&panel, id, false)?;
        Ok(())
    }
    pub fn action_result(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<Option<ActionResult>, &'static str> {
        self.expire_actions(now);
        self.authorize(window, document)?;
        let job = self.actions.get(id).ok_or("panel action expired")?;
        if job.lease.window_id != window || job.source_document != document {
            return Err("invalid action owner");
        }
        // Revoking/removing a panel or promoting a new lease also retires old
        // replies. A still-registered document alone is not result authority.
        self.owned(window, document, &job.lease)?;
        let result = job.result.clone();
        if result.is_some() {
            self.drop_action(id);
        }
        Ok(result)
    }
    pub fn cancel_action(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<bool, &'static str> {
        self.authorize(window, document)?;
        let Some(job) = self.actions.get(id) else {
            return Ok(true);
        };
        if window != MAIN && (job.lease.window_id != window || job.source_document != document) {
            return Err("invalid action owner");
        }
        // Cancellation cannot uncommit arbitrary resource work already admitted
        // to main. Its completion still releases the native migration fence.
        if job.claimed && job.result.is_none() {
            return Ok(false);
        }
        self.drop_action(id);
        Ok(true)
    }
    fn drop_action(&mut self, id: &str) {
        if let Some(job) = self.actions.remove(id) {
            let _ = self.relay_fence(&job.lease.panel_id, id, false);
        }
    }
    pub(super) fn expire_actions(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .actions
            .iter()
            .filter(|(_, job)| (!job.claimed || job.result.is_some()) && job.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.drop_action(&id);
        }
    }
    pub(super) fn retire_document_actions(&mut self, window: &str) {
        let retired: Vec<_> = self
            .actions
            .iter()
            .filter(|(_, job)| {
                window == MAIN
                    || (job.lease.window_id == window && (!job.claimed || job.result.is_some()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            self.drop_action(&id);
        }
    }
    pub(super) fn retire_panel_actions(&mut self, panel_id: &str) {
        let retired: Vec<_> = self
            .actions
            .iter()
            .filter(|(_, job)| job.lease.panel_id == panel_id && !job.claimed)
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            self.drop_action(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture {
        registry: Ownership,
        main: String,
        source: String,
        other: String,
        lease: Lease,
        now: Instant,
    }
    impl Fixture {
        fn new() -> Self {
            let mut registry = Ownership::default();
            let main = registry.register(MAIN).unwrap();
            let source = registry.register("source").unwrap();
            let other = registry.register("other").unwrap();
            for (window, document) in [(MAIN, &main), ("source", &source), ("other", &other)] {
                registry.ready(window, document).unwrap();
            }
            let now = Instant::now();
            let initial = registry.add_panel(MAIN, &main, "tasks").unwrap();
            let offer = registry
                .prepare(MAIN, &main, &initial, "source", Value::Null, now)
                .unwrap();
            registry
                .acknowledge("source", &source, &offer.id, now)
                .unwrap();
            let lease = registry.commit(MAIN, &main, &offer.id, now).unwrap();
            Self {
                registry,
                main,
                source,
                other,
                lease,
                now,
            }
        }
        fn request(&mut self) -> String {
            self.registry
                .request_action(
                    "source",
                    &self.source,
                    &self.lease,
                    ViewAction::Task {
                        key: "private-task-identity".into(),
                        ticket: "opaque-ticket".into(),
                        action_id: "pause".into(),
                    },
                    self.now,
                )
                .unwrap()
        }
        fn can_return(&mut self) -> bool {
            self.registry
                .prepare(
                    "source",
                    &self.source,
                    &self.lease,
                    MAIN,
                    Value::Null,
                    self.now,
                )
                .is_ok()
        }
        fn finish(&mut self, id: &str) {
            self.registry
                .complete_action(
                    MAIN,
                    &self.main,
                    id,
                    ActionResult::Done { value: json!(null) },
                    self.now,
                )
                .unwrap();
        }
    }
    #[test]
    fn closed_grammar_and_panel_binding_cannot_be_used_as_an_arbitrary_command_proxy() {
        for value in [
            json!({"kind":"invoke", "command":"host_delete"}),
            json!({"kind":"clearTasks", "hostId":"spoof"}),
            json!({"kind":"task","key":"k","ticket":"t","actionId":"pause","windowId":"main"}),
        ] {
            assert!(serde_json::from_value::<ViewAction>(value).is_err());
        }
        let mut f = Fixture::new();
        assert!(f
            .registry
            .request_action(
                "source",
                &f.source,
                &f.lease,
                ViewAction::Disconnect {
                    session_id: "ssh".into()
                },
                f.now
            )
            .is_err());
        assert!(f
            .registry
            .request_action(
                "source",
                &f.source,
                &f.lease,
                ViewAction::Task {
                    key: "k".repeat(1025),
                    ticket: "t".into(),
                    action_id: "pause".into()
                },
                f.now
            )
            .is_err());
        assert!(f.can_return());
    }
    #[test]
    fn admission_and_claim_are_exactly_once_and_keep_secret_requests_out_of_metadata() {
        let mut f = Fixture::new();
        let id = f.request();
        assert!(!f.can_return());
        assert!(f.registry.begin_close("source", &f.source).is_err());
        assert!(f.registry.claim_actions("other", &f.other, f.now).is_err());
        assert!(f
            .registry
            .action_result("other", &f.other, &id, f.now)
            .is_err());
        assert!(f.registry.cancel_action("other", &f.other, &id).is_err());
        let snapshot = f
            .registry
            .dispatch(
                "other",
                &f.other,
                super::super::protocol::Command::Snapshot {},
                f.now,
            )
            .unwrap();
        assert!(!snapshot.to_string().contains("private-task-identity"));
        assert!(!snapshot.to_string().contains("opaque-ticket"));
        assert!(!snapshot.to_string().contains(&id));
        assert!(f
            .registry
            .complete_action(
                MAIN,
                &f.main,
                &id,
                ActionResult::Done { value: Value::Null },
                f.now
            )
            .is_err());
        let jobs = f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, id);
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
        assert!(!f.registry.cancel_action("source", &f.source, &id).unwrap());
        assert!(f
            .registry
            .complete_action(
                MAIN,
                &f.main,
                &id,
                ActionResult::Done {
                    value: json!("x".repeat(65536))
                },
                f.now
            )
            .is_err());
        assert!(!f.can_return());
        f.finish(&id);
        assert!(matches!(
            f.registry
                .action_result("source", &f.source, &id, f.now)
                .unwrap(),
            Some(ActionResult::Done { .. })
        ));
        assert!(f
            .registry
            .action_result("source", &f.source, &id, f.now)
            .is_err());
        assert!(f.can_return());
    }
    #[test]
    fn cancellation_and_queue_deadlines_release_unsubmitted_fences_but_never_uncommit_running_work()
    {
        let mut f = Fixture::new();
        let id = f.request();
        assert!(f.registry.cancel_action("source", &f.source, &id).unwrap());
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
        let _id = f.request();
        f.registry.expire(f.now + Duration::from_secs(16));
        assert!(f.can_return());
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        f.registry.expire(f.now + Duration::from_secs(600));
        assert!(!f.can_return());
        f.finish(&id);
        assert!(f.can_return());
    }
    #[test]
    fn reloaded_or_crashed_source_cannot_replay_claimed_work_or_erase_its_native_cleanup_fence() {
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        let old_document = f.source.clone();
        f.source = f.registry.register("source").unwrap();
        f.registry.ready("source", &f.source).unwrap();
        f.lease = f.registry.leases().remove(0);
        assert!(f
            .registry
            .action_result("source", &old_document, &id, f.now)
            .is_err());
        assert!(!f.can_return());
        f.finish(&id);
        assert!(f.can_return());
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        let recovered = f.registry.destroyed("source").unwrap().remove(0);
        assert!(f
            .registry
            .prepare(MAIN, &f.main, &recovered, "other", Value::Null, f.now)
            .is_err());
        f.finish(&id);
        f.registry
            .prepare(MAIN, &f.main, &recovered, "other", Value::Null, f.now)
            .unwrap();
    }
    #[test]
    fn coordinator_reload_fences_old_completions_without_replaying_submitted_steps() {
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        let old = f.main.clone();
        f.main = f.registry.register(MAIN).unwrap();
        f.registry.ready(MAIN, &f.main).unwrap();
        assert!(f
            .registry
            .complete_action(
                MAIN,
                &old,
                &id,
                ActionResult::Done { value: Value::Null },
                f.now
            )
            .is_err());
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
        assert!(f.can_return());
    }
    #[test]
    fn pending_source_retirement_blocking_and_per_panel_limits_are_bounded() {
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.block(MAIN, &f.main, "tasks", true).unwrap();
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
        assert!(f
            .registry
            .action_result("source", &f.source, &id, f.now)
            .is_err());
        let mut f = Fixture::new();
        let mut ids = Vec::new();
        for _ in 0..8 {
            ids.push(f.request());
        }
        assert!(f
            .registry
            .request_action(
                "source",
                &f.source,
                &f.lease,
                ViewAction::ClearTasks {},
                f.now
            )
            .is_err());
        f.registry
            .cancel_action("source", &f.source, &ids[0])
            .unwrap();
        f.request();
        assert!(f.registry.destroyed(MAIN).is_err());
        assert_eq!(
            f.registry
                .claim_actions(MAIN, &f.main, f.now)
                .unwrap()
                .len(),
            8
        );
        let mut f = Fixture::new();
        f.request();
        f.registry.register("source").unwrap();
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn removed_or_replaced_panels_cannot_read_completed_replies() {
        let mut f = Fixture::new();
        let id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        f.registry.remove_panel(MAIN, &f.main, "tasks").unwrap();
        // Already submitted work still finalizes; revocation cannot replay it,
        // and a registered old document cannot receive its now-retired reply.
        f.finish(&id);
        assert!(f
            .registry
            .action_result("source", &f.source, &id, f.now)
            .is_err());
        let replacement = f.registry.add_panel(MAIN, &f.main, "tasks").unwrap();
        let offer = f
            .registry
            .prepare(MAIN, &f.main, &replacement, "source", Value::Null, f.now)
            .unwrap();
        f.registry
            .acknowledge("source", &f.source, &offer.id, f.now)
            .unwrap();
        f.registry.commit(MAIN, &f.main, &offer.id, f.now).unwrap();
        assert!(f
            .registry
            .action_result("source", &f.source, &id, f.now)
            .is_err());
    }
}
