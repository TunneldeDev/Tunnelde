//! Closed control-plane grammar. No "invoke arbitrary command" variant and no
//! caller-controlled window identity. Native transport supplies the IPC label.
use super::actions::{ActionResult, ViewAction};
use super::ownership::{Lease, Ownership};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Command {
    RequestCoordinatorPreviewAction {
        lease: Lease,
        request: ViewAction,
    },
    PublishPreviewResource {
        resource: Option<super::preview::Resource>,
    },
    OpenPreviewHandle {
        target: super::plugin_views::Target,
        resource_id: String,
    },
    ClosePreviewHandle {
        id: String,
    },
    Snapshot {},
    BeginPluginModel {
        panel_id: String,
        revision: String,
    },
    PublishPresentation {
        lease: Lease,
        metadata: super::presentation::LayoutMetadata,
    },
    PublishStagedPresentation {
        id: String,
        metadata: super::presentation::LayoutMetadata,
    },
    PublishUnavailablePreview {
        metadata: super::presentation::LayoutMetadata,
    },
    ClaimPresentations {},
    BeginPresentation {
        id: String,
    },
    CompletePresentation {
        id: String,
        metadata: super::presentation::LayoutMetadata,
    },
    FailPresentation {
        id: String,
    },
    ClaimPanelMoves {},
    PreparePanelMove {
        id: String,
        state: Value,
    },
    FailPanelMove {
        id: String,
    },
    RequestAction {
        lease: Lease,
        request: ViewAction,
    },
    ClaimActions {},
    CompleteAction {
        id: String,
        result: ActionResult,
    },
    ActionResult {
        id: String,
    },
    CancelAction {
        id: String,
    },
    Authorize {
        lease: Lease,
    },
    Ready {},
    AddPanel {
        panel_id: String,
    },
    RemovePanel {
        panel_id: String,
    },
    Checkpoint {
        lease: Lease,
        revision: u64,
        state: Value,
    },
    View {
        lease: Lease,
    },
    BeginModel {
        panel_id: String,
    },
    PublishModel {
        publisher: String,
        panel_id: String,
        revision: u64,
        model: Value,
    },
    ReadModel {
        lease: Lease,
    },
    StagedModel {
        id: String,
    },
    Prepare {
        lease: Lease,
        target_window: String,
        state: Value,
    },
    Staged {
        id: String,
    },
    Acknowledge {
        id: String,
    },
    Commit {
        id: String,
    },
    Cancel {
        id: String,
    },
    BeginInteraction {
        lease: Lease,
    },
    EndInteraction {
        lease: Lease,
        id: String,
    },
    Block {
        panel_id: String,
        blocked: bool,
    },
    IssueDrag {
        lease: Lease,
    },
    CancelDrag {
        token: String,
    },
    AcceptDrag {
        token: String,
    },
    BeginClose {},
    CancelClose {},
}
impl Ownership {
    pub fn dispatch(
        &mut self,
        window: &str,
        document: &str,
        command: Command,
        now: Instant,
    ) -> Result<Value, &'static str> {
        self.authorize(window, document)?;
        // An IPC call after a suspended process resumes must not observe or
        // revive a timed-out offer just because its timeout callback ran late.
        self.expire(now);
        match command {
            Command::RequestCoordinatorPreviewAction { lease, request } => Ok(json!(
                self.request_coordinator_preview_action(window, document, &lease, request, now)?
            )),
            Command::PublishPreviewResource { resource } => Ok(json!(
                self.publish_preview_resource(window, document, resource)?
            )),
            Command::OpenPreviewHandle {
                target,
                resource_id,
            } => Ok(json!(self.open_preview_handle(
                window,
                document,
                target,
                &resource_id,
                now
            )?)),
            Command::ClosePreviewHandle { id } => {
                self.close_preview_handle(window, document, &id)?;
                Ok(Value::Null)
            }
            Command::BeginPresentation { .. } => Err("native presentation policy required"),
            Command::ClaimPresentations {} => {
                Ok(json!(self.claim_presentations(window, document, now)?))
            }
            Command::PublishPresentation { lease, metadata } => Ok(json!(
                self.publish_presentation(window, document, &lease, metadata)?
            )),
            Command::PublishStagedPresentation { id, metadata } => Ok(json!(
                self.publish_staged_presentation(window, document, &id, metadata, now)?
            )),
            Command::PublishUnavailablePreview { metadata } => Ok(json!(
                self.publish_unavailable_preview(window, document, metadata)?
            )),
            Command::CompletePresentation { id, metadata } => {
                super::public_panels::complete(self, window, document, &id, metadata)
            }
            Command::FailPresentation { id } => {
                self.fail_presentation(window, document, &id)?;
                Ok(Value::Null)
            }
            Command::ClaimPanelMoves {}
            | Command::PreparePanelMove { .. }
            | Command::FailPanelMove { .. } => Err("native move policy required"),
            Command::BeginPluginModel { panel_id, revision } => Ok(json!(
                self.begin_plugin_model(window, document, &panel_id, &revision)?
            )),
            Command::Snapshot {} => Ok(
                json!({"windows": self.windows(), "panels": self.leases(), "transfers": self.offers(window, document)?, "interruptions": self.interruptions(), "pluginViews": self.plugin_adapters()}),
            ),
            Command::RequestAction { lease, request } => Ok(json!(
                self.request_action(window, document, &lease, request, now)?
            )),
            Command::ClaimActions {} => Ok(json!(self.claim_actions(window, document, now)?)),
            Command::CompleteAction { id, result } => {
                self.complete_action(window, document, &id, result, now)?;
                Ok(Value::Null)
            }
            Command::ActionResult { id } => {
                Ok(json!(self.action_result(window, document, &id, now)?))
            }
            Command::CancelAction { id } => Ok(json!(self.cancel_action(window, document, &id)?)),
            Command::Authorize { lease } => {
                self.action(window, document, &lease)?;
                Ok(Value::Null)
            }
            Command::Ready {} => {
                self.ready(window, document)?;
                Ok(Value::Null)
            }
            Command::AddPanel { panel_id } => {
                Ok(json!(self.add_panel(window, document, &panel_id)?))
            }
            Command::RemovePanel { panel_id } => {
                self.remove_panel(window, document, &panel_id)?;
                Ok(Value::Null)
            }
            Command::Checkpoint {
                lease,
                revision,
                state,
            } => {
                self.checkpoint(window, document, &lease, revision, state)?;
                Ok(Value::Null)
            }
            Command::View { lease } => self.view(window, document, &lease),
            Command::BeginModel { panel_id } => {
                Ok(json!(self.begin_model(window, document, &panel_id)?))
            }
            Command::PublishModel {
                publisher,
                panel_id,
                revision,
                model,
            } => {
                self.publish_model(window, document, &panel_id, &publisher, revision, model)?;
                Ok(Value::Null)
            }
            Command::ReadModel { lease } => self.read_model(window, document, &lease),
            Command::StagedModel { id } => self.staged_model(window, document, &id, now),
            Command::Prepare {
                lease,
                target_window,
                state,
            } => Ok(json!(self.prepare(
                window,
                document,
                &lease,
                &target_window,
                state,
                now
            )?)),
            Command::Staged { id } => Ok(json!(self.staged(window, document, &id, now)?)),
            Command::Acknowledge { id } => {
                self.acknowledge(window, document, &id, now)?;
                Ok(Value::Null)
            }
            Command::Commit { id } => Ok(json!(self.commit(window, document, &id, now)?)),
            Command::Cancel { id } => {
                self.cancel(window, document, &id)?;
                Ok(Value::Null)
            }
            Command::BeginInteraction { lease } => {
                Ok(json!(self.begin_interaction(window, document, &lease)?))
            }
            Command::EndInteraction { lease, id } => {
                self.end_interaction(window, document, &lease, &id)?;
                Ok(Value::Null)
            }
            Command::Block { panel_id, blocked } => {
                self.block(window, document, &panel_id, blocked)?;
                Ok(Value::Null)
            }
            Command::IssueDrag { lease } => {
                Ok(json!(self.issue_drag(window, document, &lease, now)?))
            }
            Command::AcceptDrag { token } => {
                Ok(json!(self.accept_drag(window, document, &token, now)?))
            }
            Command::CancelDrag { token } => {
                self.cancel_drag(window, document, &token)?;
                Ok(Value::Null)
            }
            Command::BeginClose {} => Ok(json!(self.begin_close(window, document)?)),
            Command::CancelClose {} => {
                self.cancel_close(window, document)?;
                Ok(Value::Null)
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_identity_is_not_deserializable_and_command_grammar_is_closed() {
        for (index, value) in [
            json!({"action":"snapshot", "windowId":"main"}),
            json!({"action":"invoke", "command":"ssh_disconnect"}),
            json!({"action":"register", "windowId":"main"}),
            json!({"action":"addPanel", "panelId":"connections", "document":"spoofed"}),
            json!({"action":"checkpoint", "lease":{"panelId":"connections","windowId":"main","generation":1,"extra":true}, "revision":1,"state":{}}),
        ].into_iter().enumerate() {
            assert!(serde_json::from_value::<Command>(value).is_err(), "case {index}");
        }
    }
    #[test]
    fn snapshots_are_advisory_metadata_and_only_participants_can_access_staged_secrets() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let one = registry.register("one").unwrap();
        let two = registry.register("two").unwrap();
        let now = Instant::now();
        for (window, document) in [("main", &main), ("one", &one), ("two", &two)] {
            registry
                .dispatch(window, document, Command::Ready {}, now)
                .unwrap();
        }
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        let offer = registry
            .prepare(
                "main",
                &main,
                &lease,
                "one",
                json!({"passwordDraft":"not-public"}),
                now,
            )
            .unwrap();
        let snapshot = registry
            .dispatch("two", &two, Command::Snapshot {}, now)
            .unwrap();
        assert_eq!(snapshot["transfers"], json!([]));
        assert!(!snapshot.to_string().contains("not-public"));
        assert!(!snapshot.to_string().contains(&main));
        assert!(registry
            .dispatch(
                "two",
                &two,
                Command::Staged {
                    id: offer.id.clone()
                },
                now
            )
            .is_err());
        assert!(registry
            .dispatch(
                "two",
                &two,
                Command::View {
                    lease: lease.clone()
                },
                now
            )
            .is_err());
        assert!(registry
            .dispatch(
                "two",
                &two,
                Command::Prepare {
                    lease: lease.clone(),
                    target_window: "one".into(),
                    state: json!({})
                },
                now
            )
            .is_err());
        assert!(registry
            .dispatch(
                "two",
                &two,
                Command::AddPanel {
                    panel_id: "foreign".into()
                },
                now
            )
            .is_err());
        let staged = registry
            .dispatch(
                "one",
                &one,
                Command::Staged {
                    id: offer.id.clone(),
                },
                now,
            )
            .unwrap();
        assert_eq!(staged["state"]["passwordDraft"], "not-public");
        registry
            .dispatch(
                "one",
                &one,
                Command::Acknowledge {
                    id: offer.id.clone(),
                },
                now,
            )
            .unwrap();
        let snapshot = registry
            .dispatch("main", &main, Command::Snapshot {}, now)
            .unwrap();
        assert_eq!(snapshot["transfers"][0]["ready"], true);
        assert!(!snapshot.to_string().contains("not-public"));
        assert!(registry
            .dispatch(
                "one",
                &one,
                Command::Commit {
                    id: offer.id.clone()
                },
                now
            )
            .is_err());
        registry
            .dispatch("main", &main, Command::Commit { id: offer.id }, now)
            .unwrap();
        assert!(registry
            .dispatch("main", "stale", Command::Snapshot {}, now)
            .is_err());
        assert!(registry
            .dispatch("rogue", &one, Command::Snapshot {}, now)
            .is_err());
    }
    #[test]
    fn dispatch_expires_offers_before_returning_a_snapshot() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let one = registry.register("one").unwrap();
        registry.ready("main", &main).unwrap();
        registry.ready("one", &one).unwrap();
        let lease = registry.add_panel("main", &main, "tasks").unwrap();
        let now = Instant::now();
        registry
            .prepare("main", &main, &lease, "one", json!({}), now)
            .unwrap();
        let snapshot = registry
            .dispatch(
                "one",
                &one,
                Command::Snapshot {},
                now + std::time::Duration::from_secs(16),
            )
            .unwrap();
        assert_eq!(snapshot["transfers"], json!([]));
        assert!(registry.action("main", &main, &lease).is_ok());
    }
}
