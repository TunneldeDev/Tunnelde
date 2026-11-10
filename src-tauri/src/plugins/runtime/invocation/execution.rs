use std::time::Duration;

use serde_json::{json, Value};

use crate::{
    error::{AppError, AppResult},
    plugins::{api, security::Lease, wasm_call, PluginStatus, PluginsManager},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

impl PluginsManager {
    pub(in crate::plugins) async fn run_bound(
        &self,
        id: &str,
        command: &str,
        input: Option<Value>,
        lease: &Lease,
    ) -> AppResult<Value> {
        self.security
            .wait_ready(lease, tokio::time::Instant::now() + super::READY_TIMEOUT)
            .await?;
        self.security
            .guard_ready(lease, self.execute_command(id, command, input, lease))
            .await
    }

    async fn execute_command(
        &self,
        id: &str,
        command: &str,
        input: Option<Value>,
        lease: &Lease,
    ) -> AppResult<Value> {
        if input
            .as_ref()
            .is_some_and(|value| !value.is_object() || value.to_string().len() > 256 * 1024)
        {
            return Err(AppError::validation("plugin.input.invalid"));
        }
        let instance = self.admit_invocation(id, lease).await?;
        instance.require_runtime()?;
        if instance.manifest.runtime.as_deref() == Some("frontend")
            || instance
                .manifest
                .commands
                .iter()
                .any(|item| item.id == command && item.frontend)
        {
            if instance.status != PluginStatus::Running
                || !instance
                    .manifest
                    .commands
                    .iter()
                    .any(|item| item.id == command)
            {
                return Err(AppError::validation("plugin.notRunning"));
            }
            let app = self
                .runtime_app
                .get()
                .cloned()
                .ok_or_else(|| AppError::validation("plugin.frontend.unavailable"))?;
            drop(instance);
            let context = api::HostContext {
                app,
                id: id.into(),
                fingerprint: lease.fingerprint.clone(),
                permissions: lease.permissions.clone(),
                generation: lease.generation,
                tool_client: None,
                tool_request: None,
            };
            return self
                .security
                .guard(
                    lease,
                    api::frontend_request(
                        &context,
                        "__frontend.command",
                        json!({"command":command,"input":input.unwrap_or_else(|| json!({})),
                            "runtimeId":self.security.lease_stamp(lease)}),
                    ),
                )
                .await;
        }
        if instance.is_wasm() {
            let result = wasm_call(
                &instance,
                json!({ "method": "run", "command": command, "input": input }),
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
        drop(instance);

        self.security
            .guard(
                lease,
                host.request(
                    "command.run",
                    json!({ "command": command, "input": input }),
                    COMMAND_TIMEOUT,
                ),
            )
            .await
    }
}
