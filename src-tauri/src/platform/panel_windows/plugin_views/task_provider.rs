//! Selected task-provider children are neither sidebar adapters nor forwarding
//! authorities. Mutations submit one exact, host-owned task action receipt.
use super::super::{actions::ViewAction, native};
use super::*;
use crate::error::{AppError, AppResult};
use crate::plugins::frontend::native::{self as frontend, Source};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

impl Ownership {
    fn task_provider_target(
        &self,
        caller: (&str, &str),
        target: &Target,
        now: Instant,
    ) -> Result<()> {
        let panel = match target {
            Target::Owned { lease } => {
                self.action(caller.0, caller.1, lease)?;
                lease.panel_id.clone()
            }
            Target::Staged { id } => {
                self.staged(caller.0, caller.1, id, now)?
                    .offer
                    .lease
                    .panel_id
            }
        };
        if panel != "tasks" {
            return Err("plugin.frontend.undeclaredContribution");
        }
        Ok(())
    }
    fn bind_task_provider(
        &mut self,
        caller: (&str, &str),
        target: Target,
        source: Source,
        token: String,
        now: Instant,
    ) -> Result<()> {
        self.task_provider_target(caller, &target, now)?;
        if source
            .provider_selection()
            .is_none_or(|p| p.target() != "backgroundTasks")
            || !source.descriptor().allow_floating
        {
            return Err("plugin.frontend.undeclaredContribution");
        }
        self.insert_native_view(
            caller,
            target,
            source.lease.clone(),
            token.clone(),
            "tasks".into(),
            None,
            now,
        )?;
        self.native_views
            .bindings
            .get_mut(&token)
            .expect("inserted child")
            .tasks_provider = Some(source);
        Ok(())
    }
    fn task_provider_source(
        &self,
        caller: (&str, &str),
        lease: &Lease,
        token: &str,
        now: Instant,
    ) -> Result<Source> {
        if lease.panel_id != "tasks"
            || self.native_view_owned_lease(caller.0, caller.1, token, now)? != *lease
        {
            return Err("plugin.backgroundTasks.changed");
        }
        self.native_views.bindings[token]
            .tasks_provider
            .clone()
            .ok_or("plugin.backgroundTasks.changed")
    }
}
fn target(app: &AppHandle, caller: (&str, &str), target: &Target) -> AppResult<()> {
    native::lock(&app.state::<native::Registry>())
        .task_provider_target(caller, target, Instant::now())
        .map_err(native::invalid)
}
fn descriptor(source: &Source, write: bool) -> Value {
    json!({"selectionRevision":source.provider_selection().expect("selected source").revision(), "capabilities":{"write":write}, "view":source.descriptor()})
}
pub(super) async fn describe(
    app: &AppHandle,
    window: &str,
    document: &str,
    requested: Target,
) -> AppResult<Value> {
    let caller = (window, document);
    target(app, caller, &requested)?;
    let Some(source) = frontend::selected_tasks_source(app).await? else {
        target(app, caller, &requested)?;
        return Ok(Value::Null);
    };
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    ownership
        .task_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    let write = match source.with_permissions(app, &["backgroundTasks.write"], || Ok(())) {
        Ok(()) => true,
        Err(AppError::Validation(message)) if message == "pluginSecurity.permissionDenied" => false,
        Err(error) => return Err(error),
    };
    source.with_current(app, || Ok(descriptor(&source, write)))
}
pub(super) async fn open(
    app: &AppHandle,
    caller: (&str, &str),
    requested: Target,
    plugin: String,
    runtime: String,
    view: String,
    revision: u64,
) -> AppResult<Value> {
    target(app, caller, &requested)?;
    let source = frontend::selected_tasks_source(app)
        .await?
        .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
    let descriptor = source.descriptor();
    if descriptor.plugin_id != plugin
        || descriptor.runtime_id != runtime
        || descriptor.view_id != view
        || !descriptor.allow_floating
        || source
            .provider_selection()
            .is_none_or(|selection| selection.revision() != revision)
    {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    ownership
        .task_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    source.with_current(app, || Ok(()))?;
    let session = frontend::open(app, source.clone())?;
    let bound = source.with_current(app, || Ok(())).and_then(|()| {
        ownership
            .bind_task_provider(
                caller,
                requested,
                source,
                session.token.clone(),
                Instant::now(),
            )
            .map_err(native::invalid)
    });
    if let Err(error) = bound {
        frontend::close(app, vec![session.token]);
        return Err(error);
    }
    Ok(json!(session))
}
pub(super) fn submit(
    app: &AppHandle,
    caller: (&str, &str),
    lease: &Lease,
    token: &str,
    key: String,
    ticket: String,
    action_id: String,
) -> AppResult<String> {
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    let now = Instant::now();
    let source = ownership
        .task_provider_source(caller, lease, token, now)
        .map_err(native::invalid)?;
    // This is the explicit submission boundary, not a bearer authorization for
    // later arbitrary calls. The bounded action queue owns the accepted effect;
    // main still resolves its exact source-incarnation ticket before execution.
    source.with_permissions(app, &["backgroundTasks.write"], || {
        ownership
            .request_action(
                caller.0,
                caller.1,
                lease,
                ViewAction::Task {
                    key,
                    ticket,
                    action_id,
                },
                now,
            )
            .map_err(native::invalid)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Ownership, String, String, Lease, Source) {
        let mut r = Ownership::default();
        let main = r.register("main").unwrap();
        let satellite = r.register("satellite").unwrap();
        r.ready("main", &main).unwrap();
        r.ready("satellite", &satellite).unwrap();
        let lease = r.add_panel("main", &main, "tasks").unwrap();
        let source = Source::test_tasks_source(
            PluginLease {
                id: "task-provider".into(),
                generation: 3,
                fingerprint: "a".repeat(64),
                permissions: vec!["ui.trusted".into(), "backgroundTasks.read".into()],
            },
            4,
        );
        (r, main, satellite, lease, source)
    }
    #[test]
    fn task_child_cannot_be_mistaken_for_sidebar_or_forwarding_provider() {
        let (mut r, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let target = Target::Owned {
            lease: lease.clone(),
        };
        assert!(r
            .native_view_target("main", &main, &target, "task-provider", "tasks", now)
            .is_err());
        assert!(r
            .bind_task_provider(
                ("satellite", &satellite),
                target.clone(),
                source.clone(),
                "foreign".into(),
                now
            )
            .is_err());
        let forwarding = Source::test_forwarding_source(source.lease.clone(), 4);
        assert!(r
            .bind_task_provider(
                ("main", &main),
                target.clone(),
                forwarding,
                "wrong-provider".into(),
                now
            )
            .is_err());
        r.bind_task_provider(("main", &main), target, source, "child".into(), now)
            .unwrap();
        assert!(r
            .task_provider_source(("main", &main), &lease, "child", now)
            .is_ok());
        assert!(r
            .forwarding_provider_authority(("main", &main), &lease, "child")
            .is_err());
        assert!(r
            .task_provider_source(("satellite", &satellite), &lease, "child", now)
            .is_err());
        assert!(r
            .task_provider_source(("main", &satellite), &lease, "child", now)
            .is_err());
        assert!(r.plugin_adapters().is_empty());
    }
    #[test]
    fn task_child_is_read_only_while_staged_and_promotes_only_with_exact_offer() {
        let (mut r, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let offer = r
            .prepare("main", &main, &lease, "satellite", Value::Null, now)
            .unwrap();
        r.bind_task_provider(
            ("satellite", &satellite),
            Target::Staged {
                id: offer.id.clone(),
            },
            source,
            "staged".into(),
            now,
        )
        .unwrap();
        assert!(r
            .task_provider_source(("satellite", &satellite), &lease, "staged", now)
            .is_err());
        r.acknowledge("satellite", &satellite, &offer.id, now)
            .unwrap();
        let moved = r.commit("main", &main, &offer.id, now).unwrap();
        assert!(r
            .task_provider_source(("satellite", &satellite), &moved, "staged", now)
            .is_ok());
        let (_, call) = r
            .native_view_call(
                "satellite",
                &satellite,
                "staged",
                CallPolicy::OwnedData,
                now,
            )
            .unwrap();
        r.close_native_view("satellite", &satellite, "staged")
            .unwrap();
        assert!(r.native_view_busy("tasks"));
        assert!(r
            .task_provider_source(("satellite", &satellite), &moved, "staged", now)
            .is_err());
        r.settle_native_view_call(&call);
        assert!(!r.native_view_busy("tasks"));
    }
    #[test]
    fn task_provider_descriptor_contains_no_activation_credential_or_raw_permissions() {
        let (_, _, _, _, source) = fixture();
        let projected = descriptor(&source, false);
        assert_eq!(projected["capabilities"]["write"], false);
        assert_eq!(projected["selectionRevision"], 4);
        assert_eq!(projected.as_object().unwrap().len(), 3);
        for forbidden in [
            "activation",
            "token",
            "fingerprint",
            "permissions",
            "private-singleton",
        ] {
            assert!(!projected.to_string().contains(forbidden));
        }
        let request = json!({"action":"submitTasksProviderAction","lease":{"panelId":"tasks","windowId":"main","generation":1},"token":"child","key":"task","ticket":"incarnation","actionId":"pause"});
        assert!(serde_json::from_value::<super::super::gateway::Request>(request.clone()).is_ok());
        for key in ["origin", "pluginId", "permissions", "command", "activation"] {
            let mut forged = request.clone();
            forged[key] = json!("forged");
            assert!(serde_json::from_value::<super::super::gateway::Request>(forged).is_err());
        }
    }
}
