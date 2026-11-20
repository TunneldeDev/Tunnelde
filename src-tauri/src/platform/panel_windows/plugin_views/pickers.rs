//! Native OS pickers belong to an exact view document, never the hidden main.
//! Cancelling delivery is not closing an accepted OS dialog: its callback owns
//! the reservation and native effect guard until the platform actually returns.
use super::{origin::Origin, Ownership, PluginLease};
use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::{native, ownership::Lease},
    plugins::{current_invocation_fence, frontend::native as frontend, InvocationFence},
    services::operations::WorkLifetime,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use std::{collections::HashMap, sync::Arc, time::Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

struct Picker {
    window: String,
    document: String,
    token: String,
    panel: Lease,
    interaction: String,
    started: bool,
}
#[derive(Default)]
pub(super) struct Pickers(HashMap<String, Picker>);
impl Pickers {
    pub(super) fn has_window(&self, window: &str) -> bool {
        self.0.values().any(|picker| picker.window == window)
    }
}
impl Ownership {
    fn begin_view_picker(
        &mut self,
        window: &str,
        document: &str,
        token: &str,
    ) -> Result<String, &'static str> {
        let panel = self.native_view_owned_lease(window, document, token, Instant::now())?;
        if self.native_views.pickers.0.len() >= 16
            || self.native_views.pickers.has_window(window)
            || self.native_views.ui.has_modal(window)
        {
            return Err("plugin.api.frontend:dialog.busy");
        }
        let interaction = self.begin_interaction(window, document, &panel)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.native_views.pickers.0.insert(
            id.clone(),
            Picker {
                window: window.into(),
                document: document.into(),
                token: token.into(),
                panel,
                interaction,
                started: false,
            },
        );
        Ok(id)
    }
    fn view_picker_owner(
        &self,
        window: &str,
        document: &str,
        token: &str,
        id: &str,
    ) -> Result<PluginLease, &'static str> {
        let picker = self
            .native_views
            .pickers
            .0
            .get(id)
            .filter(|p| p.window == window && p.document == document && p.token == token)
            .ok_or("plugin.frontend.expired")?;
        let owner = self.native_view_resource(window, document, token, Instant::now())?;
        self.require_interaction(window, document, &picker.panel, &picker.interaction)?;
        Ok(owner)
    }
    fn start_view_picker(&mut self, id: &str) -> Result<(), &'static str> {
        let picker = self
            .native_views
            .pickers
            .0
            .get_mut(id)
            .ok_or("plugin.frontend.expired")?;
        if picker.started {
            return Err("plugin.api.duplicateRequest");
        }
        picker.started = true;
        Ok(())
    }
    fn end_view_picker(&mut self, id: &str) {
        if let Some(picker) = self.native_views.pickers.0.remove(id) {
            let _ = self.end_interaction(
                &picker.window,
                &picker.document,
                &picker.panel,
                &picker.interaction,
            );
        }
    }
}

struct Guard {
    app: AppHandle,
    id: String,
    _effect: WorkLifetime,
}
impl Drop for Guard {
    fn drop(&mut self) {
        native::lock(&self.app.state::<native::Registry>()).end_view_picker(&self.id);
        native::changed(&self.app);
    }
}
fn authorized<T>(
    ownership: &mut Ownership,
    origin: &Origin,
    id: &str,
    fence: &Option<InvocationFence>,
    operation: impl FnOnce(&mut Ownership) -> AppResult<T>,
    app: &AppHandle,
) -> AppResult<T> {
    let owner = ownership
        .view_picker_owner(&origin.window, &origin.document, &origin.token, id)
        .map_err(native::invalid)?;
    if owner != origin.plugin {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    frontend::with_owner_permissions(app, &origin.token, &owner, &["mounts.write"], || {
        let work = || operation(ownership);
        if let Some(fence) = fence {
            fence.with_live(work)
        } else {
            work()
        }
    })
}

pub(crate) async fn pick_folder(
    app: &AppHandle,
    origin: Origin,
    title: String,
) -> AppResult<Option<String>> {
    let fence = current_invocation_fence();
    let id = {
        let registry = app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        origin.authorize(&ownership)?;
        frontend::with_owner_permissions(
            app,
            &origin.token,
            &origin.plugin,
            &["mounts.write"],
            || {
                let mut begin = || {
                    ownership
                        .begin_view_picker(&origin.window, &origin.document, &origin.token)
                        .map_err(native::invalid)
                };
                if let Some(fence) = &fence {
                    fence.with_live(begin)
                } else {
                    begin()
                }
            },
        )?
    };
    let guard = Arc::new(Guard {
        app: app.clone(),
        id,
        _effect: WorkLifetime::current(),
    });
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let callback_guard = guard.clone();
    let callback_fence = fence.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let started = {
            let registry = handle.state::<native::Registry>();
            let mut ownership = native::lock(&registry);
            authorized(
                &mut ownership,
                &origin,
                &callback_guard.id,
                &callback_fence,
                |ownership| {
                    let parent = handle
                        .get_webview_window(&origin.window)
                        .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
                    // set_parent silently falls back to no parent on invalid
                    // handles. Reject instead of opening an unscoped dialog.
                    parent
                        .window_handle()
                        .map_err(|_| AppError::validation("plugin.frontend.expired"))?;
                    parent
                        .display_handle()
                        .map_err(|_| AppError::validation("plugin.frontend.expired"))?;
                    ownership
                        .start_view_picker(&callback_guard.id)
                        .map_err(native::invalid)?;
                    Ok(parent)
                },
                &handle,
            )
        };
        let parent = match started {
            Ok(parent) => parent,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        };
        // Platform/UI calls run outside ownership/security/invocation locks.
        // The callback retains its exact old document reservation even if the
        // receiver is cancelled, reloaded or retired before the OS responds.
        handle
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title(title)
            .pick_folder(move |path| {
                let registry = callback_guard.app.state::<native::Registry>();
                let mut ownership = native::lock(&registry);
                let result = authorized(
                    &mut ownership,
                    &origin,
                    &callback_guard.id,
                    &callback_fence,
                    |_| Ok(path.map(|p| p.to_string())),
                    &callback_guard.app,
                );
                let _ = sender.send(result);
            });
    })?;
    let cancelled = async {
        if let Some(fence) = fence {
            fence.cancelled().await
        } else {
            std::future::pending().await
        }
    };
    tokio::select! {
        biased;
        () = cancelled => Err(AppError::validation("plugin.api.cancelled")),
        reply = receiver => reply.map_err(|_| AppError::internal("dialog.cancelled"))?,
    }
}

#[cfg(test)]
mod tests;
