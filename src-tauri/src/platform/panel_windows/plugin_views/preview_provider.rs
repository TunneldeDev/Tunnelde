//! Selected preview presentation children. Source endpoint permissions are
//! checked against the current host model, never caller-provided file metadata.
use super::super::{actions::ViewAction, native};
use super::*;
use crate::error::{AppError, AppResult};
use crate::plugins::frontend::native::{self as frontend, Source};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(super) struct Selection {
    pub plugin: String,
    pub runtime: String,
    pub view: String,
    pub revision: u64,
    pub source_kind: String,
}
impl Ownership {
    fn preview_provider_target(
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
        if panel != "filePreview" {
            return Err("plugin.frontend.undeclaredContribution");
        }
        Ok(())
    }
    pub(super) fn preview_provider_endpoint(&self) -> AppResult<(&'static str, &'static str)> {
        match self
            .panels
            .get("filePreview")
            .and_then(|p| p.model.pointer("/preview/snapshot/source/kind"))
            .and_then(Value::as_str)
        {
            Some("local") => Ok(("local", "fs.read")),
            Some("remote") => Ok(("remote", "sftp.read")),
            _ => Err(AppError::validation("plugin.filePreview.changed")),
        }
    }
    fn bind_preview_provider(
        &mut self,
        caller: (&str, &str),
        target: Target,
        source: Source,
        token: String,
        now: Instant,
    ) -> Result<()> {
        self.preview_provider_target(caller, &target, now)?;
        if source
            .provider_selection()
            .is_none_or(|p| p.target() != "filePreview")
            || !source.descriptor().allow_floating
        {
            return Err("plugin.frontend.undeclaredContribution");
        }
        self.insert_native_view(
            caller,
            target,
            source.lease.clone(),
            token.clone(),
            "filePreview".into(),
            None,
            now,
        )?;
        self.native_views
            .bindings
            .get_mut(&token)
            .expect("inserted child")
            .preview_provider = Some(source);
        Ok(())
    }
    fn preview_provider_source(
        &self,
        caller: (&str, &str),
        lease: &Lease,
        token: &str,
        now: Instant,
    ) -> Result<Source> {
        if lease.panel_id != "filePreview"
            || self.native_view_owned_lease(caller.0, caller.1, token, now)? != *lease
        {
            return Err("plugin.filePreview.changed");
        }
        self.native_views.bindings[token]
            .preview_provider
            .clone()
            .ok_or("plugin.filePreview.changed")
    }
}
fn target(app: &AppHandle, caller: (&str, &str), target: &Target) -> AppResult<()> {
    native::lock(&app.state::<native::Registry>())
        .preview_provider_target(caller, target, Instant::now())
        .map_err(native::invalid)
}
pub(super) async fn describe(
    app: &AppHandle,
    window: &str,
    document: &str,
    requested: Target,
) -> AppResult<Value> {
    let caller = (window, document);
    target(app, caller, &requested)?;
    let Some(source) = frontend::selected_preview_source(app).await? else {
        target(app, caller, &requested)?;
        return Ok(Value::Null);
    };
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    ownership
        .preview_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    let (kind, permission) = ownership.preview_provider_endpoint()?;
    source.with_permissions(app, &[permission], || Ok(()))?;
    let write = match source.with_permissions(app, &["filePreview.write"], || Ok(())) {
        Ok(()) => true,
        Err(AppError::Validation(message)) if message == "pluginSecurity.permissionDenied" => false,
        Err(error) => return Err(error),
    };
    source.with_permissions(app, &[permission], || Ok(json!({"selectionRevision":source.provider_selection().expect("selected source").revision(), "sourceKind":kind, "capabilities":{"write":write}, "view":source.descriptor()})))
}
pub(super) async fn open(
    app: &AppHandle,
    caller: (&str, &str),
    requested: Target,
    selected: Selection,
) -> AppResult<Value> {
    let Selection {
        plugin,
        runtime,
        view,
        revision,
        source_kind,
    } = selected;
    target(app, caller, &requested)?;
    let source = frontend::selected_preview_source(app)
        .await?
        .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
    let descriptor = source.descriptor();
    if descriptor.plugin_id != plugin
        || descriptor.runtime_id != runtime
        || descriptor.view_id != view
        || !descriptor.allow_floating
        || source
            .provider_selection()
            .is_none_or(|s| s.revision() != revision)
    {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    ownership
        .preview_provider_target(caller, &requested, Instant::now())
        .map_err(native::invalid)?;
    let (kind, permission) = ownership.preview_provider_endpoint()?;
    if kind != source_kind {
        return Err(AppError::validation("plugin.filePreview.changed"));
    }
    source.with_permissions(app, &[permission], || Ok(()))?;
    let session = frontend::open(app, source.clone())?;
    let bound = source
        .with_permissions(app, &[permission], || Ok(()))
        .and_then(|()| {
            ownership
                .bind_preview_provider(
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
    request: ViewAction,
) -> AppResult<String> {
    if !matches!(&request, ViewAction::Preview { command, .. } if command.provider_action()) {
        return Err(AppError::validation("plugin.filePreview.invalid"));
    }
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    let now = Instant::now();
    let source = ownership
        .preview_provider_source(caller, lease, token, now)
        .map_err(native::invalid)?;
    let (_, permission) = ownership.preview_provider_endpoint()?;
    source.with_permissions(app, &[permission, "filePreview.write"], || {
        ownership
            .request_action(caller.0, caller.1, lease, request, now)
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
        let lease = r.add_panel("main", &main, "filePreview").unwrap();
        r.panels.get_mut("filePreview").unwrap().model =
            json!({"preview":{"snapshot":{"source":{"kind":"remote"}}}});
        let source = Source::test_preview_source(
            PluginLease {
                id: "preview-ui".into(),
                generation: 3,
                fingerprint: "a".repeat(64),
                permissions: vec![
                    "ui.trusted".into(),
                    "filePreview.read".into(),
                    "sftp.read".into(),
                ],
            },
            4,
        );
        (r, main, satellite, lease, source)
    }
    #[test]
    fn child_authority_is_not_a_task_forwarding_or_generic_sidebar_token() {
        let (mut r, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let target = Target::Owned {
            lease: lease.clone(),
        };
        assert!(r
            .bind_preview_provider(
                ("satellite", &satellite),
                target.clone(),
                source.clone(),
                "foreign".into(),
                now
            )
            .is_err());
        assert!(r
            .bind_preview_provider(
                ("main", &main),
                target.clone(),
                Source::test_tasks_source(source.lease.clone(), 4),
                "tasks".into(),
                now
            )
            .is_err());
        assert!(r
            .bind_preview_provider(
                ("main", &main),
                target.clone(),
                Source::test_forwarding_source(source.lease.clone(), 4),
                "forwarding".into(),
                now
            )
            .is_err());
        r.bind_preview_provider(("main", &main), target, source, "child".into(), now)
            .unwrap();
        assert!(r
            .preview_provider_source(("main", &main), &lease, "child", now)
            .is_ok());
        assert!(r.native_views.bindings["child"].tasks_provider.is_none());
        assert!(r
            .preview_provider_source(("satellite", &satellite), &lease, "child", now)
            .is_err());
        r.register("main").unwrap();
        assert!(r
            .preview_provider_source(("main", &main), &lease, "child", now)
            .is_err());
    }
    #[test]
    fn staged_preview_child_promotes_in_place_and_cancellation_or_owner_freeze_denies_effects() {
        let (mut r, main, satellite, lease, source) = fixture();
        let now = Instant::now();
        let offer = r
            .prepare("main", &main, &lease, "satellite", Value::Null, now)
            .unwrap();
        r.bind_preview_provider(
            ("satellite", &satellite),
            Target::Staged {
                id: offer.id.clone(),
            },
            source,
            "child".into(),
            now,
        )
        .unwrap();
        assert!(r
            .preview_provider_source(("satellite", &satellite), &lease, "child", now)
            .is_err());
        r.acknowledge("satellite", &satellite, &offer.id, now)
            .unwrap();
        let moved = r.commit("main", &main, &offer.id, now).unwrap();
        assert!(r
            .preview_provider_source(("satellite", &satellite), &moved, "child", now)
            .is_ok());
        let back = r
            .prepare("satellite", &satellite, &moved, "main", Value::Null, now)
            .unwrap();
        assert!(r
            .preview_provider_source(("satellite", &satellite), &moved, "child", now)
            .is_err());
        r.cancel("satellite", &satellite, &back.id).unwrap();
        assert!(r
            .preview_provider_source(("satellite", &satellite), &moved, "child", now)
            .is_ok());
        let back = r
            .prepare("satellite", &satellite, &moved, "main", Value::Null, now)
            .unwrap();
        let second =
            Source::test_preview_source(r.native_views.bindings["child"].plugin.clone(), 4);
        r.bind_preview_provider(
            ("main", &main),
            Target::Staged {
                id: back.id.clone(),
            },
            second,
            "cancelled".into(),
            now,
        )
        .unwrap();
        r.cancel("satellite", &satellite, &back.id).unwrap();
        assert!(r
            .native_view_owner("main", &main, "cancelled", now)
            .is_err());
    }
    #[test]
    fn source_endpoint_is_derived_only_from_the_authoritative_model() {
        let (mut r, _, _, _, _) = fixture();
        assert_eq!(
            r.preview_provider_endpoint().unwrap(),
            ("remote", "sftp.read")
        );
        r.panels.get_mut("filePreview").unwrap().model =
            json!({"preview":{"snapshot":{"source":{"kind":"local"}}}});
        assert_eq!(r.preview_provider_endpoint().unwrap(), ("local", "fs.read"));
        r.panels.get_mut("filePreview").unwrap().model = json!({"sourceKind":"local"});
        assert!(r.preview_provider_endpoint().is_err());
        for command in [
            super::super::super::actions::PreviewCommand::Ready {},
            super::super::super::actions::PreviewCommand::DecodeError {},
            super::super::super::actions::PreviewCommand::Edit {},
        ] {
            assert!(!command.provider_action());
        }
    }
}
