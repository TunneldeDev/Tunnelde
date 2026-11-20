//! Host-list provider presentation children. No second singleton activation or
//! raw host commands; plugin effects still use the scoped native API gateway.
use super::super::native;
use super::*;
use crate::error::{AppError, AppResult};
use crate::plugins::frontend::native::{self as frontend, Source};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

impl Ownership {
    fn host_provider_target(
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
        if panel != "hosts" {
            return Err("plugin.frontend.undeclaredContribution");
        }
        Ok(())
    }
    fn bind_host_provider(
        &mut self,
        caller: (&str, &str),
        target: Target,
        source: Source,
        token: String,
        now: Instant,
    ) -> Result<()> {
        self.host_provider_target(caller, &target, now)?;
        if source
            .provider_selection()
            .is_none_or(|p| p.target() != "hostList")
            || !source.descriptor().allow_floating
        {
            return Err("plugin.frontend.undeclaredContribution");
        }
        self.insert_native_view(
            caller,
            target,
            source.lease.clone(),
            token.clone(),
            "hosts".into(),
            None,
            now,
        )?;
        self.native_views
            .bindings
            .get_mut(&token)
            .expect("inserted child")
            .hosts_provider = Some(source);
        Ok(())
    }
}
fn target(app: &AppHandle, caller: (&str, &str), target: &Target) -> AppResult<()> {
    native::lock(&app.state::<native::Registry>())
        .host_provider_target(caller, target, Instant::now())
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
    let Some(source) = frontend::selected_hosts_source(app).await? else {
        target(app, caller, &requested)?;
        return Ok(Value::Null);
    };
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    ownership
        .host_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    let write = match source.with_permissions(app, &["hosts.write"], || Ok(())) {
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
    let source = frontend::selected_hosts_source(app)
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
        .host_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    source.with_current(app, || Ok(()))?;
    let session = frontend::open(app, source.clone())?;
    let bound = source.with_current(app, || Ok(())).and_then(|()| {
        ownership
            .bind_host_provider(
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Ownership, String, String, Lease, Source) {
        let mut r = Ownership::default();
        let main = r.register("main").unwrap();
        let satellite = r.register("satellite").unwrap();
        r.ready("main", &main).unwrap();
        r.ready("satellite", &satellite).unwrap();
        let lease = r.add_panel("main", &main, "hosts").unwrap();
        let source = Source::test_hosts_source(
            PluginLease {
                id: "host-provider".into(),
                generation: 3,
                fingerprint: "a".repeat(64),
                permissions: vec!["ui.trusted".into(), "hosts.read".into()],
            },
            4,
        );
        (r, main, satellite, lease, source)
    }
    #[test]
    fn host_selection_has_its_own_permission_contract_and_no_activation_metadata() {
        let (_, _, _, _, source) = fixture();
        assert_eq!(
            source.provider_selection().unwrap().permissions(),
            &["ui.trusted", "hosts.read"]
        );
        let value = descriptor(&source, false);
        assert_eq!(value["selectionRevision"], 4);
        assert_eq!(value["view"]["viewId"], "hosts");
        for hidden in [
            "activation",
            "token",
            "permissions",
            "private-singleton",
            "fingerprint",
        ] {
            assert!(!value.to_string().contains(hidden));
        }
    }
    #[test]
    fn host_provider_authority_is_not_an_ordinary_sidebar_or_cross_panel_grant() {
        let (mut r, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let target = Target::Owned {
            lease: lease.clone(),
        };
        assert!(r
            .native_view_target("main", &main, &target, "host-provider", "hosts", now)
            .is_err());
        assert!(r
            .bind_host_provider(
                ("satellite", &satellite),
                target.clone(),
                source.clone(),
                "foreign".into(),
                now
            )
            .is_err());
        let ordinary = Source::test_source(
            source.lease.clone(),
            "runtime",
            "hosts",
            true,
            "private-singleton",
        );
        assert!(r
            .bind_host_provider(
                ("main", &main),
                target.clone(),
                ordinary,
                "ordinary".into(),
                now
            )
            .is_err());
        r.bind_host_provider(
            ("main", &main),
            target,
            source.clone(),
            "original".into(),
            now,
        )
        .unwrap();
        let offer = r
            .prepare("main", &main, &lease, "satellite", Value::Null, now)
            .unwrap();
        assert!(r
            .native_view_owned_lease("main", &main, "original", now)
            .is_err());
        r.bind_host_provider(
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
            .native_view_owned_lease("satellite", &satellite, "staged", now)
            .is_err());
        r.acknowledge("satellite", &satellite, &offer.id, now)
            .unwrap();
        let promoted = r.commit("main", &main, &offer.id, now).unwrap();
        assert_eq!(
            r.native_view_owned_lease("satellite", &satellite, "staged", now)
                .unwrap(),
            promoted
        );
        assert!(r
            .native_view_owned_lease("main", &main, "original", now)
            .is_err());
        let reload = r.register("satellite").unwrap();
        r.ready("satellite", &reload).unwrap();
        assert!(r
            .native_view_owned_lease("satellite", &reload, "staged", now)
            .is_err());
        assert!(r
            .native_view_owned_lease("satellite", &satellite, "staged", now)
            .is_err());
    }
}
