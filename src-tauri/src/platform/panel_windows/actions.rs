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
    Transfer {
        key: String,
        ticket: String,
        command: TransferControl,
    },
    TransferResume {
        key: String,
        ticket: String,
        interaction: String,
    },
    TransferPrompt {
        key: String,
        ticket: String,
        interaction: String,
        handle: String,
        command: TransferPrompt,
    },
    RefreshKnownHosts {},
    ForgetKnownHost {
        entry: crate::db::known_hosts::KnownHostEntry,
    },
    Output {
        operation: OutputOperation,
    },
    CopyOutput {
        text: String,
    },
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
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OutputOperation {
    Refresh,
    Clear,
    OpenLatest,
    OpenDirectory,
}
// Feature-specific closed grammar. Secrets exist only in the bounded private
// action queue, never in model snapshots, drag grants or layout state.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum TransferControl {
    Pause,
    Cancel,
    Clear,
    SpeedLimit { kib: u32 },
    Inspect { location: TransferLocation },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TransferLocation {
    From,
    To,
    Backup,
    BackupDestination,
    Artifact,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PromptCredential {
    password: Option<String>,
    passphrase: Option<String>,
}
type PromptCredentials = std::collections::BTreeMap<String, PromptCredential>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TransferPrompt {
    Prepare,
    Close,
    Probe {
        credentials: PromptCredentials,
    },
    Trust {
        fingerprint: String,
        expected_host_id: String,
        credentials: PromptCredentials,
    },
    Connect {
        password: Option<String>,
        passphrase: Option<String>,
        credentials: PromptCredentials,
    },
    Test {
        id: String,
        credentials: PromptCredentials,
    },
    CancelTest {
        id: String,
    },
    Credential {
        host_id: String,
        password: Option<String>,
    },
    InstallKey {
        password: Option<String>,
        credentials: PromptCredentials,
    },
}
fn secret(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|s| s.len() <= 8192)
}
impl TransferPrompt {
    fn valid(&self) -> bool {
        let credentials = match self {
            Self::Probe { credentials }
            | Self::Trust { credentials, .. }
            | Self::Connect { credentials, .. }
            | Self::Test { credentials, .. }
            | Self::InstallKey { credentials, .. } => Some(credentials),
            _ => None,
        };
        if credentials.is_some_and(|c| {
            c.len() > 32
                || c.iter().any(|(id, c)| {
                    id.is_empty()
                        || id.len() > 128
                        || !secret(&c.password)
                        || !secret(&c.passphrase)
                })
        }) {
            return false;
        }
        match self {
            Self::Trust {
                fingerprint,
                expected_host_id,
                ..
            } => {
                !fingerprint.is_empty()
                    && fingerprint.len() <= 1024
                    && !expected_host_id.is_empty()
                    && expected_host_id.len() <= 128
            }
            Self::Connect {
                password,
                passphrase,
                ..
            } => secret(password) && secret(passphrase),
            Self::Test { id, .. } | Self::CancelTest { id } => !id.is_empty() && id.len() <= 128,
            Self::Credential { host_id, password } => {
                !host_id.is_empty() && host_id.len() <= 128 && secret(password)
            }
            Self::InstallKey { password, .. } => secret(password),
            _ => true,
        }
    }
}
impl ViewAction {
    fn panel(&self) -> &'static str {
        match self {
            Self::RefreshKnownHosts {} | Self::ForgetKnownHost { .. } => "knownHosts",
            Self::Task { .. }
            | Self::ClearTasks {}
            | Self::Transfer { .. }
            | Self::TransferResume { .. }
            | Self::TransferPrompt { .. } => "tasks",
            Self::Disconnect { .. } => "connections",
            Self::Output { .. } | Self::CopyOutput { .. } => "output",
        }
    }
    fn validate(&self) -> Result<(), &'static str> {
        let bounded = |s: &str, max| !s.is_empty() && s.len() <= max;
        let valid = match self {
            Self::Transfer {
                key,
                ticket,
                command,
            } => {
                bounded(key, 1024)
                    && bounded(ticket, 128)
                    && match command {
                        TransferControl::SpeedLimit { kib } => *kib <= 1_048_576,
                        _ => true,
                    }
            }
            Self::TransferResume {
                key,
                ticket,
                interaction,
            } => bounded(key, 1024) && bounded(ticket, 128) && bounded(interaction, 128),
            Self::TransferPrompt {
                key,
                ticket,
                interaction,
                handle,
                command,
            } => {
                bounded(key, 1024)
                    && bounded(ticket, 128)
                    && bounded(interaction, 128)
                    && bounded(handle, 128)
                    && command.valid()
            }
            Self::Task {
                key,
                ticket,
                action_id,
            } => bounded(key, 1024) && bounded(ticket, 128) && bounded(action_id, 128),
            Self::Disconnect { session_id } => bounded(session_id, 128),
            Self::RefreshKnownHosts {} => true,
            Self::ForgetKnownHost { entry } => {
                bounded(&entry.host, 4096)
                    && (1..=65535).contains(&entry.port)
                    && bounded(&entry.algorithm, 256)
                    && bounded(&entry.fingerprint, 1024)
                    && entry.updated_at >= 0
            }
            Self::ClearTasks {} | Self::Output { .. } => true,
            Self::CopyOutput { text } => bounded(text, 2 * 1024 * 1024),
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
    fn authorize_action_interaction(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &ViewAction,
    ) -> Result<(), &'static str> {
        match request {
            ViewAction::TransferResume { interaction, .. }
            | ViewAction::TransferPrompt { interaction, .. } => {
                self.require_interaction(window, document, lease, interaction)
            }
            _ => Ok(()),
        }
    }
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
        if serde_json::to_vec(&request)
            .map_err(|_| "invalid panel action")?
            .len()
            > 2 * 1024 * 1024 + 4096
        {
            return Err("panel action limit");
        }
        self.authorize_action_interaction(window, document, lease, &request)?;
        if request.panel() != lease.panel_id {
            return Err("wrong panel action");
        }
        if self.actions.len() + self.interrupted.len() >= 64
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
            if self
                .authorize_action_interaction(
                    &lease.window_id,
                    &source,
                    &lease,
                    &self.actions[&id].request,
                )
                .is_err()
                || coordinator != document
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
        if self.interrupted.contains_key(id) || (job.claimed && job.result.is_none()) {
            return Ok(false);
        }
        self.drop_action(id);
        Ok(true)
    }
    fn drop_action(&mut self, id: &str) {
        if let Some(job) = self.actions.remove(id) {
            if !self.interrupted.contains_key(id) {
                let _ = self.relay_fence(&job.lease.panel_id, id, false);
            }
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
        if window == MAIN {
            // Losing the JS coordinator does not prove its submitted native
            // effects have stopped. Never replay them or silently unlock the
            // panel. Return a bounded unknown-outcome failure to live callers;
            // keep the native safety quarantine independently of reply lifetime.
            for (id, job) in &mut self.actions {
                if job.claimed && job.result.is_none() {
                    self.interrupted
                        .insert(id.clone(), job.lease.panel_id.clone());
                    job.result = Some(ActionResult::Failed {
                        message: "panels.actionInterrupted".into(),
                    });
                    job.deadline = Instant::now() + RESULT_TTL;
                }
            }
        }
        let retired: Vec<_> = self
            .actions
            .iter()
            .filter(|(_, job)| {
                (window == MAIN && !job.claimed)
                    || (job.lease.window_id == window && (!job.claimed || job.result.is_some()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            self.drop_action(&id);
        }
    }
    /// Relayed jobs retain settlement/quarantine independently of panel records.
    /// Direct native effects have no such side-table and must retain the panel.
    pub(super) fn retains_relay_fence(&self, id: &str) -> bool {
        self.actions.contains_key(id) || self.interrupted.contains_key(id)
    }
    pub(super) fn panel_interrupted(&self, panel_id: &str) -> bool {
        self.interrupted.values().any(|id| id == panel_id)
    }
    pub(super) fn interruptions(&self) -> Vec<serde_json::Value> {
        let mut counts = std::collections::BTreeMap::<&str, usize>::new();
        for panel in self.interrupted.values() {
            *counts.entry(panel).or_default() += 1;
        }
        counts
            .into_iter()
            .map(|(panel_id, count)| serde_json::json!({ "panelId": panel_id, "count": count }))
            .collect()
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
    fn transfer_grammar_is_closed_bounded_and_cannot_accept_arbitrary_targets() {
        for value in [
            json!({"kind":"transfer","key":"k","ticket":"t","command":{"operation":"inspect","location":"to","path":"/arbitrary"}}),
            json!({"kind":"transferPrompt","key":"k","ticket":"t","interaction":"g","handle":"p","command":{"operation":"connect","hostId":"other","credentials":{}}}),
            json!({"kind":"transfer","key":"k","ticket":"t","command":{"operation":"speedLimit","kib":-1}}),
            json!({"kind":"transferPrompt","key":"k","ticket":"t","interaction":"g","handle":"p","command":{"operation":"probe","credentials":{"h":{"password":"secret","keyPath":"/bad"}}}}),
        ] {
            assert!(serde_json::from_value::<ViewAction>(value).is_err());
        }
        for value in [
            json!({"kind":"transfer","key":"k","ticket":"t","command":{"operation":"speedLimit","kib":1048577}}),
            json!({"kind":"transferPrompt","key":"k","ticket":"t","interaction":"g","handle":"p","command":{"operation":"connect","password":"x".repeat(8193),"credentials":{}}}),
            json!({"kind":"transferResume","key":"k","ticket":"t","interaction":""}),
        ] {
            assert!(serde_json::from_value::<ViewAction>(value)
                .unwrap()
                .validate()
                .is_err());
        }
    }
    #[test]
    fn transfer_consent_is_checked_on_admission_and_claim_not_just_in_react() {
        let mut f = Fixture::new();
        let request = |interaction: &str| ViewAction::TransferResume {
            key: "k".into(),
            ticket: "t".into(),
            interaction: interaction.into(),
        };
        assert!(f
            .registry
            .request_action("source", &f.source, &f.lease, request("fake"), f.now)
            .is_err());
        let guard = f
            .registry
            .begin_interaction("source", &f.source, &f.lease)
            .unwrap();
        let id = f
            .registry
            .request_action("source", &f.source, &f.lease, request(&guard), f.now)
            .unwrap();
        f.registry
            .end_interaction("source", &f.source, &f.lease, &guard)
            .unwrap();
        assert!(f
            .registry
            .claim_actions(MAIN, &f.main, f.now)
            .unwrap()
            .is_empty());
        assert!(f
            .registry
            .action_result("source", &f.source, &id, f.now)
            .is_err());
        assert!(f.can_return());
        let mut f = Fixture::new();
        let guard = f
            .registry
            .begin_interaction("source", &f.source, &f.lease)
            .unwrap();
        let request = ViewAction::TransferPrompt {
            key: "private-task".into(),
            ticket: "private-ticket".into(),
            interaction: guard.clone(),
            handle: "private-handle".into(),
            command: TransferPrompt::Connect {
                password: Some("private-password".into()),
                passphrase: None,
                credentials: Default::default(),
            },
        };
        let id = f
            .registry
            .request_action("source", &f.source, &f.lease, request, f.now)
            .unwrap();
        let metadata = f
            .registry
            .dispatch(
                "other",
                &f.other,
                super::super::protocol::Command::Snapshot {},
                f.now,
            )
            .unwrap()
            .to_string();
        for secret in [
            &guard,
            "private-password",
            "private-handle",
            "private-ticket",
            "private-task",
        ] {
            assert!(!metadata.contains(secret));
        }
        assert_eq!(
            f.registry
                .claim_actions(MAIN, &f.main, f.now)
                .unwrap()
                .len(),
            1
        );
        f.registry
            .end_interaction("source", &f.source, &f.lease, &guard)
            .unwrap();
        assert!(!f.can_return()); // Admitted effect fence outlives the dialog.
        f.finish(&id);
        assert!(f.can_return());
        assert!(f
            .registry
            .request_action(
                "source",
                &f.source,
                &f.lease,
                ViewAction::TransferResume {
                    key: "k".into(),
                    ticket: "t".into(),
                    interaction: guard
                },
                f.now
            )
            .is_err());
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
    fn coordinator_reload_quarantines_unknown_effects_without_replaying_or_reporting_success() {
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
        assert!(!f.can_return());
        assert!(!f.registry.cancel_action("source", &f.source, &id).unwrap());
        assert!(
            matches!(f.registry.action_result("source", &f.source, &id, f.now).unwrap(), Some(ActionResult::Failed { message }) if message == "panels.actionInterrupted")
        );
        f.registry.expire(f.now + Duration::from_secs(600));
        f.registry.block(MAIN, &f.main, "tasks", false).unwrap();
        assert!(!f.can_return());
        assert!(f
            .registry
            .authorize_creation("source", &f.source, Some(&f.lease))
            .is_err());
        let metadata = f
            .registry
            .dispatch(
                "other",
                &f.other,
                super::super::protocol::Command::Snapshot {},
                f.now,
            )
            .unwrap();
        assert_eq!(
            metadata["interruptions"],
            json!([{"panelId":"tasks","count":1}])
        );
        for private in [id.as_str(), "private-task-identity", "opaque-ticket"] {
            assert!(!metadata.to_string().contains(private));
        }
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
    #[test]
    fn coordinator_loss_quarantine_survives_reply_expiry_crash_and_panel_id_reuse() {
        let mut f = Fixture::new();
        let _id = f.request();
        f.registry.claim_actions(MAIN, &f.main, f.now).unwrap();
        f.main = f.registry.register(MAIN).unwrap();
        f.registry.ready(MAIN, &f.main).unwrap();
        f.registry.expire(f.now + Duration::from_secs(600));
        let recovered = f.registry.destroyed("source").unwrap().remove(0);
        assert!(f
            .registry
            .prepare(MAIN, &f.main, &recovered, "other", Value::Null, f.now)
            .is_err());
        f.registry.remove_panel(MAIN, &f.main, "tasks").unwrap();
        let replacement = f.registry.add_panel(MAIN, &f.main, "tasks").unwrap();
        assert!(f
            .registry
            .prepare(MAIN, &f.main, &replacement, "other", Value::Null, f.now)
            .is_err());
        // An unrelated adapter is not globally blocked by this unknown outcome.
        let connection = f.registry.add_panel(MAIN, &f.main, "connections").unwrap();
        assert!(f
            .registry
            .prepare(MAIN, &f.main, &connection, "other", Value::Null, f.now)
            .is_ok());
    }
}
