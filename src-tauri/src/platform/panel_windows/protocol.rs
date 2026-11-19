//! Closed control-plane grammar. No "invoke arbitrary command" variant and no
//! caller-controlled window identity. Native transport supplies the IPC label.
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
    Snapshot {},
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
    Block {
        panel_id: String,
        blocked: bool,
    },
    IssueDrag {
        lease: Lease,
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
            Command::Snapshot {} => Ok(
                json!({"windows": self.windows(), "panels": self.leases(), "transfers": self.offers(window, document)?}),
            ),
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
