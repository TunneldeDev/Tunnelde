//! Selected forwarding attachments use native-bound handles, not activation
//! credentials, an ordinary-plugin adapter or a second singleton activation.
use super::*;
use crate::platform::panel_windows::native;
use crate::plugins::frontend::native::{self as frontend, Source};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub(super) struct Binding {
    source: Source,
    host: String,
}
impl Binding {
    pub(super) fn check(&self, app: &AppHandle) -> AppResult<()> {
        self.source.with_current(app, || {
            app.state::<AppState>()
                .db
                .with(|conn| crate::db::hosts::find_host(conn, &self.host).map(|_| ()))
        })
    }
}
/// Process-local continuation, never Serialize/Deserialize or a raw provider
/// bearer scope. Each effect still checks the issuing native attachment.
pub(in crate::platform::panel_windows) struct ForwardingAuthority {
    token: String,
    binding: Binding,
}
impl ForwardingAuthority {
    pub(in crate::platform::panel_windows) fn token(&self) -> &str {
        &self.token
    }
    pub(in crate::platform::panel_windows) fn host(&self) -> &str {
        &self.binding.host
    }
    pub(in crate::platform::panel_windows) fn owner(&self) -> (String, u64) {
        (
            self.binding.source.lease.id.clone(),
            self.binding.source.lease.generation,
        )
    }
    pub(in crate::platform::panel_windows) fn check_binding(
        &self,
        ownership: &Ownership,
        caller: (&str, &str),
        lease: &Lease,
    ) -> Result<()> {
        ownership.forwarding_provider_binding(caller, lease, &self.token)?;
        let binding = ownership.native_views.bindings[&self.token]
            .provider
            .as_ref()
            .expect("provider binding");
        if binding.host != self.binding.host || !binding.source.same_module(&self.binding.source) {
            return Err("plugin.forwarding.expired");
        }
        Ok(())
    }
    pub(in crate::platform::panel_windows) fn with_current<T>(
        &self,
        app: &AppHandle,
        write: bool,
        operation: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        self.binding.source.with_permissions(
            app,
            if write { &["forwards.write"] } else { &[] },
            operation,
        )
    }
}
impl Ownership {
    pub(in crate::platform::panel_windows) fn forwarding_provider_binding(
        &self,
        caller: (&str, &str),
        lease: &Lease,
        token: &str,
    ) -> Result<()> {
        if lease.panel_id != "forwarding"
            || self.native_view_owned_lease(caller.0, caller.1, token, Instant::now())? != *lease
            || self.native_views.bindings[token].provider.is_none()
        {
            return Err("plugin.forwarding.expired");
        }
        Ok(())
    }
    pub(in crate::platform::panel_windows) fn forwarding_provider_authority(
        &self,
        caller: (&str, &str),
        lease: &Lease,
        token: &str,
    ) -> Result<ForwardingAuthority> {
        self.forwarding_provider_binding(caller, lease, token)?;
        Ok(ForwardingAuthority {
            token: token.into(),
            binding: self.native_views.bindings[token]
                .provider
                .as_ref()
                .expect("provider binding")
                .clone(),
        })
    }
    fn forwarding_provider_target(
        &self,
        window: &str,
        document: &str,
        target: &Target,
        now: Instant,
    ) -> Result<()> {
        let panel = match target {
            Target::Owned { lease } => {
                self.action(window, document, lease)?;
                &lease.panel_id
            }
            Target::Staged { id } => {
                let offer = self.staged(window, document, id, now)?;
                if offer.offer.lease.panel_id != "forwarding" {
                    return Err("plugin.frontend.undeclaredContribution");
                }
                return Ok(());
            }
        };
        if panel != "forwarding" {
            return Err("plugin.frontend.undeclaredContribution");
        }
        Ok(())
    }
    pub(super) fn native_provider_current(
        &self,
        app: &AppHandle,
        window: &str,
        document: &str,
        token: &str,
    ) -> AppResult<()> {
        let view = self
            .native_view(window, document, token, Instant::now())
            .map_err(native::invalid)?;
        if let Some(binding) = &view.provider {
            binding.check(app)?;
        }
        Ok(())
    }
    fn bind_forwarding_provider(
        &mut self,
        caller: (&str, &str),
        target: Target,
        source: Source,
        host: String,
        token: String,
        now: Instant,
    ) -> Result<()> {
        self.forwarding_provider_target(caller.0, caller.1, &target, now)?;
        if source.provider_selection().is_none() || !source.descriptor().allow_floating {
            return Err("plugin.frontend.undeclaredContribution");
        }
        self.insert_native_view(
            caller,
            target,
            source.lease.clone(),
            token,
            "forwarding".into(),
            Some(Binding { source, host }),
            now,
        )
    }
}
fn target(app: &AppHandle, window: &str, document: &str, target: &Target) -> AppResult<()> {
    native::lock(&app.state::<native::Registry>())
        .forwarding_provider_target(window, document, target, Instant::now())
        .map_err(native::invalid)
}
fn descriptor(source: &Source, write: bool) -> Value {
    json!({
        "selectionRevision": source.provider_selection().expect("selected source").revision(),
        "capabilities": { "write": write },
        "view": source.descriptor(),
    })
}
pub(super) async fn describe(
    app: &AppHandle,
    window: &str,
    document: &str,
    requested: Target,
) -> AppResult<Value> {
    target(app, window, document, &requested)?;
    let Some(source) = frontend::selected_forwarding_source(app).await? else {
        target(app, window, document, &requested)?;
        return Ok(Value::Null);
    };
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    ownership
        .forwarding_provider_target(window, document, &requested, Instant::now())
        .map_err(native::invalid)?;
    // Declared permissions are not necessarily granted. Check the optional
    // write grant separately, then revalidate the exact generation/selection
    // while projecting metadata. Never recursively acquire Source locks from
    // inside with_current, and never turn lifecycle errors into read-only hints.
    let write = match source.with_permissions(app, &["forwards.write"], || Ok(())) {
        Ok(()) => true,
        Err(AppError::Validation(message)) if message == "pluginSecurity.permissionDenied" => false,
        Err(error) => return Err(error),
    };
    source.with_current(app, || Ok(descriptor(&source, write)))
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn open(
    app: &AppHandle,
    window: &str,
    document: &str,
    requested: Target,
    host: String,
    plugin: String,
    runtime: String,
    view: String,
    revision: u64,
) -> AppResult<Value> {
    target(app, window, document, &requested)?;
    if host.is_empty()
        || host.len() > 128
        || host.chars().any(char::is_control)
        || host.starts_with(crate::plugins::host_sources::PREFIX)
    {
        return Err(AppError::validation("plugin.forwarding.expired"));
    }
    let source = frontend::selected_forwarding_source(app)
        .await?
        .ok_or_else(|| AppError::validation("plugin.forwarding.expired"))?;
    let descriptor = source.descriptor();
    if descriptor.plugin_id != plugin
        || descriptor.runtime_id != runtime
        || descriptor.view_id != view
        || !descriptor.allow_floating
        || source
            .provider_selection()
            .is_none_or(|selection| selection.revision() != revision)
    {
        return Err(AppError::validation("plugin.forwarding.expired"));
    }
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    ownership
        .forwarding_provider_target(window, document, &requested, Instant::now())
        .map_err(native::invalid)?;
    let binding = Binding {
        source: source.clone(),
        host: host.clone(),
    };
    binding.check(app)?;
    let session = frontend::open(app, source.clone())?;
    // A selection may change while the child is allocated. Never deliver that
    // old attachment or retain an orphaned module on final admission failure.
    let bound = binding.check(app).and_then(|_| {
        ownership
            .bind_forwarding_provider(
                (window, document),
                requested,
                source,
                host,
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Ownership, String, String, Lease, Source) {
        let mut ownership = Ownership::default();
        let main = ownership.register("main").unwrap();
        let satellite = ownership.register("satellite").unwrap();
        ownership.ready("main", &main).unwrap();
        ownership.ready("satellite", &satellite).unwrap();
        let lease = ownership.add_panel("main", &main, "forwarding").unwrap();
        let source = Source::test_forwarding_source(
            PluginLease {
                id: "provider".into(),
                generation: 5,
                fingerprint: "a".repeat(64),
                permissions: vec![
                    "ui.trusted".into(),
                    "hosts.read".into(),
                    "forwards.read".into(),
                ],
            },
            4,
        );
        (ownership, main, satellite, lease, source)
    }
    #[test]
    fn selected_descriptor_exposes_granted_write_hint_but_no_bearer_or_permission_list() {
        let (_, _, _, _, source) = fixture();
        for write in [false, true] {
            let value = descriptor(&source, write);
            assert_eq!(value["capabilities"]["write"], write);
            assert_eq!(value["selectionRevision"], 4);
            assert_eq!(value["view"]["pluginId"], "provider");
            assert_eq!(value.as_object().unwrap().len(), 3);
            assert_eq!(value["view"].as_object().unwrap().len(), 8);
            let wire = value.to_string();
            for secret in [
                "private-singleton",
                "fingerprint",
                "permissions",
                "activation",
                "token",
            ] {
                assert!(!wire.contains(secret), "leaked {secret}");
            }
        }
    }
    #[test]
    fn provider_binding_is_not_an_ordinary_sidebar_or_permission_to_register_an_adapter() {
        let (mut ownership, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let was_transferable = ownership.transferable("forwarding");
        assert!(ownership
            .native_view_target(
                "main",
                &main,
                &Target::Owned {
                    lease: lease.clone()
                },
                "provider",
                "forwards",
                now
            )
            .is_err());
        let ordinary = Source::test_source(
            source.lease.clone(),
            "runtime",
            "forwards",
            true,
            "private-singleton",
        );
        assert!(ownership
            .bind_forwarding_provider(
                ("main", &main),
                Target::Owned {
                    lease: lease.clone()
                },
                ordinary,
                "host".into(),
                "ordinary".into(),
                now
            )
            .is_err());
        assert!(ownership
            .bind_forwarding_provider(
                ("satellite", &satellite),
                Target::Owned {
                    lease: lease.clone()
                },
                source.clone(),
                "host".into(),
                "foreign".into(),
                now
            )
            .is_err());
        ownership
            .bind_forwarding_provider(
                ("main", &main),
                Target::Owned {
                    lease: lease.clone(),
                },
                source.clone(),
                "host".into(),
                "bound".into(),
                now,
            )
            .unwrap();
        assert_eq!(
            ownership
                .native_view_owner("main", &main, "bound", now)
                .unwrap(),
            source.lease
        );
        assert_eq!(
            ownership.native_views.bindings["bound"]
                .provider
                .as_ref()
                .unwrap()
                .host,
            "host"
        );
        assert_eq!(
            ownership.transferable("forwarding"),
            was_transferable,
            "provider attachment must not alter host presentation admission"
        );
        assert!(ownership.plugin_adapters().is_empty());
        assert!(ownership
            .native_view_owner("satellite", &satellite, "bound", now)
            .is_err());
    }
    #[test]
    fn staged_provider_promotes_only_by_exact_handoff_and_keeps_actual_effect_on_close() {
        let (mut ownership, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let offer = ownership
            .prepare("main", &main, &lease, "satellite", Value::Null, now)
            .unwrap();
        ownership
            .bind_forwarding_provider(
                ("satellite", &satellite),
                Target::Staged {
                    id: offer.id.clone(),
                },
                source,
                "host".into(),
                "staged-provider".into(),
                now,
            )
            .unwrap();
        assert!(ownership
            .native_view_resource("satellite", &satellite, "staged-provider", now)
            .is_err());
        ownership
            .acknowledge("satellite", &satellite, &offer.id, now)
            .unwrap();
        let moved = ownership.commit("main", &main, &offer.id, now).unwrap();
        ownership
            .native_view_resource("satellite", &satellite, "staged-provider", now)
            .unwrap();
        let (_, call) = ownership
            .native_view_call(
                "satellite",
                &satellite,
                "staged-provider",
                CallPolicy::OwnedData,
                now,
            )
            .unwrap();
        assert!(ownership
            .close_native_view("main", &main, "staged-provider")
            .is_err());
        ownership
            .close_native_view("satellite", &satellite, "staged-provider")
            .unwrap();
        assert!(ownership.remove_panel("main", &main, "forwarding").is_err());
        ownership.settle_native_view_call(&call);
        assert_eq!(ownership.leases()[0], moved);
        ownership.remove_panel("main", &main, "forwarding").unwrap();
    }
    #[test]
    fn closed_provider_grammar_rejects_activation_authority_and_arbitrary_commands() {
        let wire = json!({"action":"openForwardingProvider","target":{"kind":"owned","lease":{"panelId":"forwarding","windowId":"main","generation":1}},"hostId":"host","pluginId":"provider","runtimeId":"runtime","viewId":"forwards","selectionRevision":4});
        assert!(serde_json::from_value::<super::super::gateway::Request>(wire.clone()).is_ok());
        for field in ["activation", "token", "origin", "permissions", "command"] {
            let mut forged = wire.clone();
            forged[field] = json!("injected");
            assert!(serde_json::from_value::<super::super::gateway::Request>(forged).is_err());
        }
        let (ownership, main, _, _, _) = fixture();
        let unrelated = Lease {
            panel_id: "tasks".into(),
            window_id: "main".into(),
            generation: 1,
        };
        assert!(ownership
            .forwarding_provider_target(
                "main",
                &main,
                &Target::Owned { lease: unrelated },
                Instant::now()
            )
            .is_err());
    }
    #[test]
    fn native_forwarding_continuation_keeps_exact_child_host_runtime_and_committed_owner() {
        let (mut ownership, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        ownership
            .bind_forwarding_provider(
                ("main", &main),
                Target::Owned {
                    lease: lease.clone(),
                },
                source.clone(),
                "selected-host".into(),
                "original".into(),
                now,
            )
            .unwrap();
        let authority = ownership
            .forwarding_provider_authority(("main", &main), &lease, "original")
            .unwrap();
        assert_eq!(authority.host(), "selected-host");
        assert_eq!(authority.owner(), ("provider".into(), 5));
        authority
            .check_binding(&ownership, ("main", &main), &lease)
            .unwrap();
        assert!(authority
            .check_binding(&ownership, ("satellite", &satellite), &lease)
            .is_err());
        let offer = ownership
            .prepare("main", &main, &lease, "satellite", Value::Null, now)
            .unwrap();
        ownership
            .bind_forwarding_provider(
                ("satellite", &satellite),
                Target::Staged {
                    id: offer.id.clone(),
                },
                source.clone(),
                "selected-host".into(),
                "staged".into(),
                now,
            )
            .unwrap();
        assert!(ownership
            .forwarding_provider_authority(("satellite", &satellite), &lease, "staged")
            .is_err());
        assert!(authority
            .check_binding(&ownership, ("main", &main), &lease)
            .is_err());
        ownership.cancel("main", &main, &offer.id).unwrap();
        ownership
            .close_native_view("main", &main, "original")
            .unwrap();
        ownership
            .bind_forwarding_provider(
                ("main", &main),
                Target::Owned {
                    lease: lease.clone(),
                },
                source,
                "selected-host".into(),
                "replacement".into(),
                now,
            )
            .unwrap();
        assert!(
            authority
                .check_binding(&ownership, ("main", &main), &lease)
                .is_err(),
            "replacement child revived retained authority"
        );
        ownership
            .forwarding_provider_authority(("main", &main), &lease, "replacement")
            .unwrap();
    }
}
