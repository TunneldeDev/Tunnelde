use super::*;
use serde_json::{json, Value};
use std::time::Duration;

struct Fixture {
    r: Ownership,
    main: String,
    target: String,
    other: String,
    lease: Lease,
    plugin: PluginLease,
    now: Instant,
}
impl Fixture {
    fn new() -> Self {
        let mut r = Ownership::default();
        let main = r.register("main").unwrap();
        let target = r.register("target").unwrap();
        let other = r.register("other").unwrap();
        for (w, d) in [("main", &main), ("target", &target), ("other", &other)] {
            r.ready(w, d).unwrap();
        }
        let lease = r.add_panel("main", &main, "plugin:sample:files").unwrap();
        let plugin = PluginLease {
            id: "sample".into(),
            generation: 4,
            fingerprint: "a".repeat(64),
            permissions: vec!["ui.trusted".into()],
        };
        Self {
            r,
            main,
            target,
            other,
            lease,
            plugin,
            now: Instant::now(),
        }
    }
    fn owned(&mut self, token: &str) {
        self.r
            .bind_native_view(
                ("main", &self.main),
                Target::Owned {
                    lease: self.lease.clone(),
                },
                self.plugin.clone(),
                "files",
                token.into(),
                self.now,
            )
            .unwrap();
    }
    fn offer(&mut self) -> String {
        self.r
            .prepare(
                "main",
                &self.main,
                &self.lease,
                "target",
                json!({"draft":"not a token"}),
                self.now,
            )
            .unwrap()
            .id
    }
    fn staged(&mut self, id: &str, token: &str) {
        self.r
            .bind_native_view(
                ("target", &self.target),
                Target::Staged { id: id.into() },
                self.plugin.clone(),
                "files",
                token.into(),
                self.now,
            )
            .unwrap();
    }
    fn commit(&mut self, id: &str) -> Lease {
        self.r
            .acknowledge("target", &self.target, id, self.now)
            .unwrap();
        self.r.commit("main", &self.main, id, self.now).unwrap()
    }
    fn owner(&self, w: &str, d: &str, token: &str) -> Result<PluginLease> {
        self.r.native_view_owner(w, d, token, self.now)
    }
    fn prune(&mut self) -> Vec<String> {
        self.r.prune_native_views(self.now, |_, _| true)
    }
}
#[test]
fn native_view_requires_exact_document_panel_and_contribution_not_token_possession() {
    let mut f = Fixture::new();
    f.owned("owner");
    assert_eq!(f.owner("main", &f.main, "owner").unwrap(), f.plugin);
    assert!(f.owner("target", &f.target, "owner").is_err());
    assert!(f.owner("other", &f.other, "owner").is_err());
    assert!(f.owner("main", &f.target, "owner").is_err());
    assert!(f
        .r
        .bind_native_view(
            ("main", &f.main),
            Target::Owned {
                lease: f.lease.clone()
            },
            f.plugin.clone(),
            "another-view",
            "wrong".into(),
            f.now
        )
        .is_err());
    assert!(f
        .r
        .bind_native_view(
            ("target", &f.target),
            Target::Owned {
                lease: f.lease.clone()
            },
            f.plugin.clone(),
            "files",
            "wrong".into(),
            f.now
        )
        .is_err());
    let mut foreign = f.plugin.clone();
    foreign.id = "foreign".into();
    assert!(f
        .r
        .bind_native_view(
            ("main", &f.main),
            Target::Owned {
                lease: f.lease.clone()
            },
            foreign,
            "files",
            "wrong".into(),
            f.now
        )
        .is_err());
    assert!(f.r.close_native_view("target", &f.target, "owner").is_err());
    assert!(f.owner("main", &f.main, "owner").is_ok());
    let snapshot =
        f.r.dispatch(
            "other",
            &f.other,
            super::super::protocol::Command::Snapshot {},
            f.now,
        )
        .unwrap();
    for secret in ["owner", &f.main, &f.plugin.fingerprint] {
        assert!(!snapshot.to_string().contains(secret));
    }
}
#[test]
fn staged_view_promotes_only_inside_the_exact_successful_commit() {
    let mut f = Fixture::new();
    f.owned("source");
    let id = f.offer();
    f.staged(&id, "destination");
    assert!(f
        .r
        .native_view_call("main", &f.main, "source", CallPolicy::Metadata, f.now)
        .is_err());
    assert!(f
        .r
        .native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::BusEffect,
            f.now
        )
        .is_err());
    let (_, call) =
        f.r.native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::Metadata,
            f.now,
        )
        .unwrap();
    f.r.acknowledge("target", &f.target, &id, f.now).unwrap();
    assert!(f.r.commit("main", &f.main, &id, f.now).is_err());
    f.r.settle_native_view_call(&call);
    let lease = f.commit(&id);
    assert_eq!(
        f.owner("target", &f.target, "destination").unwrap(),
        f.plugin
    );
    assert!(f.owner("main", &f.main, "source").is_err());
    assert_eq!(f.prune(), ["source"]);
    let (_, call) =
        f.r.native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::BusEffect,
            f.now,
        )
        .unwrap();
    assert!(f.r.begin_close("target", &f.target).is_err());
    assert!(f
        .r
        .prepare("target", &f.target, &lease, "main", Value::Null, f.now)
        .is_err());
    f.r.settle_native_view_call(&call);
    f.r.prepare("target", &f.target, &lease, "main", Value::Null, f.now)
        .unwrap();
}
#[test]
fn cancelled_offer_cannot_resurrect_when_same_panel_later_reaches_same_target() {
    let mut f = Fixture::new();
    let first = f.offer();
    f.staged(&first, "old");
    f.r.cancel("target", &f.target, &first).unwrap();
    // Deliberately don't prune: invalid authority must fail even if cleanup is delayed.
    let next = f.offer();
    f.staged(&next, "new");
    f.commit(&next);
    assert!(f.owner("target", &f.target, "old").is_err());
    assert!(f.owner("target", &f.target, "new").is_ok());
    assert_eq!(f.prune(), ["old"]);
    assert!(!f.r.close_native_view("target", &f.target, "old").unwrap());
    assert!(f.owner("target", &f.target, "new").is_ok());
}
#[test]
fn reload_block_remove_expiry_and_native_destruction_revoke_without_promoting() {
    for kind in [
        "reload-source",
        "reload-target",
        "block",
        "remove",
        "expire",
        "destroy-target",
        "destroy-source",
    ] {
        let mut f = Fixture::new();
        f.owned("source");
        let id = f.offer();
        f.staged(&id, "stage");
        match kind {
            "reload-source" => {
                f.r.register("main").unwrap();
            }
            "reload-target" => {
                f.r.register("target").unwrap();
            }
            "block" => {
                f.r.block("main", &f.main, &f.lease.panel_id, true).unwrap();
            }
            "remove" => {
                f.r.remove_panel("main", &f.main, &f.lease.panel_id)
                    .unwrap();
            }
            "expire" => {
                f.now += Duration::from_secs(16);
            }
            "destroy-target" => {
                f.r.destroyed("target").unwrap();
            }
            "destroy-source" => {
                // The main document is never destroyed; first move to a real satellite.
                f.commit(&id);
                f.r.destroyed("target").unwrap();
            }
            _ => unreachable!(),
        }
        assert!(f.owner("target", &f.target, "stage").is_err(), "{kind}");
        assert!(
            f.r.native_view_call("target", &f.target, "stage", CallPolicy::BusEffect, f.now)
                .is_err(),
            "{kind}"
        );
        assert!(f.prune().contains(&"stage".into()), "{kind}");
    }
}
#[test]
fn admitted_call_fence_survives_close_retirement_reload_and_cannot_remove_readd_around_it() {
    let mut f = Fixture::new();
    f.owned("view");
    let (_, id) =
        f.r.native_view_call("main", &f.main, "view", CallPolicy::BusEffect, f.now)
            .unwrap();
    assert!(f.r.close_native_view("main", &f.main, "view").unwrap());
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    assert!(f
        .r
        .remove_panel("main", &f.main, &f.lease.panel_id)
        .is_err());
    f.main = f.r.register("main").unwrap();
    f.r.ready("main", &f.main).unwrap();
    f.lease = f.r.leases().remove(0);
    assert!(f
        .r
        .prepare("main", &f.main, &f.lease, "target", Value::Null, f.now)
        .is_err());
    assert!(f
        .r
        .remove_panel("main", &f.main, &f.lease.panel_id)
        .is_err());
    assert!(f.r.retire_native_views("sample", u64::MAX).is_empty());
    f.r.settle_native_view_call("unrelated");
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    f.r.settle_native_view_call(&id);
    f.r.settle_native_view_call(&id);
    assert!(!f.r.native_view_busy(&f.lease.panel_id));
    f.r.remove_panel("main", &f.main, &f.lease.panel_id)
        .unwrap();
    let replacement = f.r.add_panel("main", &f.main, &f.lease.panel_id).unwrap();
    assert!(replacement.generation > f.lease.generation);
    f.r.settle_native_view_call(&id);
    assert!(f.r.panels[&replacement.panel_id].native_actions.is_empty());
}
#[test]
fn runtime_retirement_uses_captured_generation_and_does_not_release_running_calls() {
    let mut f = Fixture::new();
    f.owned("old");
    let (_, id) =
        f.r.native_view_call("main", &f.main, "old", CallPolicy::BusEffect, f.now)
            .unwrap();
    f.plugin.generation += 1;
    f.owned("new");
    assert_eq!(f.r.retire_native_views("sample", 5), ["old"]);
    assert!(f.owner("main", &f.main, "new").is_ok());
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    f.r.settle_native_view_call(&id);
    assert!(f.r.retire_native_views("sample", 5).is_empty());
    assert_eq!(
        f.r.prune_native_views(f.now, |token, _| token != "new"),
        ["new"]
    );
}
#[test]
fn native_view_and_actual_call_limits_are_bounded_and_recover_only_on_real_settlement() {
    let mut f = Fixture::new();
    for i in 0..MAX_VIEWS {
        f.owned(&format!("v{i}"));
    }
    assert!(f
        .r
        .bind_native_view(
            ("main", &f.main),
            Target::Owned {
                lease: f.lease.clone()
            },
            f.plugin.clone(),
            "files",
            "excess".into(),
            f.now
        )
        .is_err());
    let mut calls = Vec::new();
    for _ in 0..8 {
        calls.push(
            f.r.native_view_call("main", &f.main, "v0", CallPolicy::BusEffect, f.now)
                .unwrap()
                .1,
        );
    }
    assert!(f
        .r
        .native_view_call("main", &f.main, "v1", CallPolicy::BusEffect, f.now)
        .is_err());
    f.r.close_native_view("main", &f.main, "v0").unwrap();
    assert!(f
        .r
        .native_view_call("main", &f.main, "v1", CallPolicy::BusEffect, f.now)
        .is_err());
    f.r.settle_native_view_call(&calls.remove(0));
    f.r.native_view_call("main", &f.main, "v1", CallPolicy::BusEffect, f.now)
        .unwrap();
}
#[test]
fn gateway_and_target_dtos_reject_rogue_fields_and_raw_application_commands() {
    use super::gateway::Request;
    for value in [
        json!({"action":"close","token":"x","window":"main"}),
        json!({"action":"call","token":"x","method":"api.describe","params":{},"requestId":"r","document":"forged"}),
        json!({"action":"invoke","command":"ssh_connect"}),
    ] {
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    assert!(
        serde_json::from_value::<Target>(json!({"kind":"staged","id":"offer","lease":{}})).is_err()
    );
    assert!(serde_json::from_value::<Target>(json!({"kind":"owned","lease":{"panelId":"x","windowId":"main","generation":1,"document":"forged"}})).is_err());
    assert!(serde_json::from_value::<Request>(json!({"action":"prepareCall","token":"x"})).is_ok());
}

#[test]
fn global_call_budget_is_independent_of_bindings_and_recovers_without_cross_panel_release() {
    let mut f = Fixture::new();
    let mut first = None;
    for panel in 0..9 {
        let view = format!("view{panel}");
        let lease =
            f.r.add_panel("main", &f.main, &format!("plugin:sample:{view}"))
                .unwrap();
        let token = format!("token{panel}");
        f.r.bind_native_view(
            ("main", &f.main),
            Target::Owned { lease },
            f.plugin.clone(),
            &view,
            token.clone(),
            f.now,
        )
        .unwrap();
        if panel < 8 {
            for _ in 0..8 {
                let (_, call) =
                    f.r.native_view_call("main", &f.main, &token, CallPolicy::BusEffect, f.now)
                        .unwrap();
                first.get_or_insert(call);
            }
        } else {
            assert!(f
                .r
                .native_view_call("main", &f.main, &token, CallPolicy::BusEffect, f.now)
                .is_err());
        }
    }
    f.r.settle_native_view_call(&first.unwrap());
    f.r.native_view_call("main", &f.main, "token8", CallPolicy::BusEffect, f.now)
        .unwrap();
    assert!(f.r.native_view_busy("plugin:sample:view0"));
    assert!(f.r.native_view_busy("plugin:sample:view8"));
}

#[test]
fn passive_receivers_do_not_block_move_and_cannot_drain_from_staged_frozen_or_old_owners() {
    let mut f = Fixture::new();
    f.owned("source");
    let (_, receive) =
        f.r.native_view_call("main", &f.main, "source", CallPolicy::BusReceive, f.now)
            .unwrap();
    assert!(!f.r.native_view_busy(&f.lease.panel_id));
    assert_eq!(
        f.r.native_view_resource("main", &f.main, "source", f.now)
            .unwrap(),
        f.plugin
    );
    let offer = f.offer();
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_err());
    f.staged(&offer, "destination");
    assert!(f
        .r
        .native_view_resource("target", &f.target, "destination", f.now)
        .is_err());
    for policy in [CallPolicy::BusEffect, CallPolicy::BusReceive] {
        assert!(f
            .r
            .native_view_call("target", &f.target, "destination", policy, f.now)
            .is_err());
    }
    let lease = f.commit(&offer);
    // No pruning/JS cancellation is needed for the final consumption gate.
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_err());
    assert_eq!(
        f.r.native_view_resource("target", &f.target, "destination", f.now)
            .unwrap(),
        f.plugin
    );
    let (_, effect) =
        f.r.native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::BusEffect,
            f.now,
        )
        .unwrap();
    f.r.settle_native_view_call(&receive);
    assert!(f.r.native_view_busy(&lease.panel_id));
    assert!(f.r.begin_close("target", &f.target).is_err());
    f.r.settle_native_view_call(&effect);
    assert!(!f.r.native_view_busy(&lease.panel_id));
}

#[test]
fn passive_calls_still_obey_budgets_and_late_settlement_cannot_release_a_replacement_effect() {
    let mut f = Fixture::new();
    f.owned("source");
    let mut calls = Vec::new();
    for _ in 0..8 {
        calls.push(
            f.r.native_view_call("main", &f.main, "source", CallPolicy::BusReceive, f.now)
                .unwrap()
                .1,
        );
    }
    assert!(f
        .r
        .native_view_call("main", &f.main, "source", CallPolicy::BusReceive, f.now)
        .is_err());
    assert!(!f.r.native_view_busy(&f.lease.panel_id));
    f.r.remove_panel("main", &f.main, &f.lease.panel_id)
        .unwrap();
    f.lease = f.r.add_panel("main", &f.main, &f.lease.panel_id).unwrap();
    f.owned("new");
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_err());
    // A new token/document cannot evade the still-live per-panel call budget.
    assert!(f
        .r
        .native_view_call("main", &f.main, "new", CallPolicy::BusEffect, f.now)
        .is_err());
    f.r.settle_native_view_call(&calls.remove(0));
    let (_, effect) =
        f.r.native_view_call("main", &f.main, "new", CallPolicy::BusEffect, f.now)
            .unwrap();
    for call in calls {
        f.r.settle_native_view_call(&call);
    }
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    f.r.settle_native_view_call(&effect);
    assert!(!f.r.native_view_busy(&f.lease.panel_id));
}

#[test]
fn resource_consumption_rechecks_blocks_reload_and_exact_document_without_fencing_itself_out() {
    let mut f = Fixture::new();
    f.owned("source");
    let (_, effect) =
        f.r.native_view_call("main", &f.main, "source", CallPolicy::BusEffect, f.now)
            .unwrap();
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_ok());
    assert!(f
        .r
        .native_view_resource("target", &f.target, "source", f.now)
        .is_err());
    f.r.block("main", &f.main, &f.lease.panel_id, true).unwrap();
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_err());
    f.r.block("main", &f.main, &f.lease.panel_id, false)
        .unwrap();
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_ok());
    f.main = f.r.register("main").unwrap();
    f.r.ready("main", &f.main).unwrap();
    assert!(f
        .r
        .native_view_resource("main", &f.main, "source", f.now)
        .is_err());
    f.r.settle_native_view_call(&effect);
}

#[test]
fn persistent_data_effects_require_committed_ownership_and_fence_actual_settlement() {
    let mut f = Fixture::new();
    f.owned("source");
    let (_, effect) =
        f.r.native_view_call("main", &f.main, "source", CallPolicy::OwnedData, f.now)
            .unwrap();
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    assert!(f
        .r
        .prepare("main", &f.main, &f.lease, "target", Value::Null, f.now)
        .is_err());
    assert!(f
        .r
        .remove_panel("main", &f.main, &f.lease.panel_id)
        .is_err());
    // Retiring the JS attachment is NOT evidence that a disk/keyring worker
    // stopped; another attachment cannot move the panel past it.
    f.r.close_native_view("main", &f.main, "source").unwrap();
    assert!(f.r.native_view_busy(&f.lease.panel_id));
    f.r.settle_native_view_call(&effect);
    assert!(!f.r.native_view_busy(&f.lease.panel_id));
    let offer = f.offer();
    f.staged(&offer, "destination");
    assert!(f
        .r
        .native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::OwnedData,
            f.now,
        )
        .is_err());
    let lease = f.commit(&offer);
    assert!(f
        .r
        .native_view_call("main", &f.main, "source", CallPolicy::OwnedData, f.now,)
        .is_err());
    let (_, effect) =
        f.r.native_view_call(
            "target",
            &f.target,
            "destination",
            CallPolicy::OwnedData,
            f.now,
        )
        .unwrap();
    assert!(f.r.begin_close("target", &f.target).is_err());
    f.r.settle_native_view_call(&effect);
    assert!(!f.r.native_view_busy(&lease.panel_id));
    f.r.begin_close("target", &f.target).unwrap();
}
