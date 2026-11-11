use std::time::Duration;

use serde_json::{json, Value};

use crate::{
    error::{AppError, AppResult},
    plugins::{declarative, security::Lease, wasm_call, PluginsManager},
};

const RENDER_TIMEOUT: Duration = Duration::from_secs(20);

impl PluginsManager {
    pub async fn render_view(
        &self,
        id: &str,
        view: &str,
        locale: Option<&str>,
        runtime_id: &str,
    ) -> AppResult<Value> {
        let lease = self.invocation_lease(id, runtime_id)?;
        self.security
            .wait_ready(&lease, tokio::time::Instant::now() + super::READY_TIMEOUT)
            .await?;
        self.security
            .guard_ready(&lease, self.render_bound(id, view, locale, &lease))
            .await
    }

    async fn render_bound(
        &self,
        id: &str,
        view: &str,
        locale: Option<&str>,
        lease: &Lease,
    ) -> AppResult<Value> {
        let instance = self.admit_invocation(id, lease).await?;
        instance.require_runtime()?;
        if instance.manifest.runtime.as_deref() == Some("declarative") {
            if !instance.manifest.views.iter().any(|item| item.id == view) {
                return Err(AppError::NotFound("plugin.view.notFound".into()));
            }
            let result = declarative::render(&instance.dir, &instance.manifest.main, view);
            self.security.authorize(
                id,
                &lease.fingerprint,
                &lease.permissions,
                None,
                Some(lease.generation),
            )?;
            return result;
        }
        if instance.is_wasm() {
            let result = wasm_call(
                &instance,
                json!({ "method": "render", "view": view, "locale": locale }),
                &self.security,
                lease,
            );
            self.security.authorize(
                id,
                &lease.fingerprint,
                &lease.permissions,
                None,
                Some(lease.generation),
            )?;
            return result;
        }
        let host = instance
            .host
            .as_ref()
            .ok_or_else(|| AppError::Validation("plugin.notRunning".into()))?
            .connection();
        // An async plugin reply must not hold up its other commands/views or
        // lifecycle changes. This transport remains bound to the captured lease.
        drop(instance);

        self.security
            .guard(
                lease,
                host.request(
                    "view.render",
                    json!({ "view": view, "locale": locale }),
                    RENDER_TIMEOUT,
                ),
            )
            .await
    }
}
