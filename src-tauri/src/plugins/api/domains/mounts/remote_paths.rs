//! A directory read never follows a group onto a replacement SSH connection.
use super::{lease, HostContext};
use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::plugin_views::origin::{self, Origin},
    plugins::{
        api::{field, optional},
        InvocationFence,
    },
    services::mounts::runtime::ConnectionStatus,
    ssh::{
        files::directory::{self, Policy, Query},
        session::{ClientHandler, SessionIdentity},
    },
    state::AppState,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

#[derive(Clone)]
struct Target {
    group: String,
    host: String,
    session: String,
    connected_at: Option<i64>,
}
impl Target {
    fn capture(states: &[ConnectionStatus], group: &str) -> AppResult<Self> {
        let status = states
            .iter()
            .find(|s| s.group_id == group && s.phase == "connected")
            .ok_or_else(missing)?;
        Ok(Self {
            group: group.into(),
            host: status.host_id.clone(),
            session: status.session_id.clone().ok_or_else(missing)?,
            connected_at: status.connected_at,
        })
    }
    fn recheck(&self, states: &[ConnectionStatus]) -> AppResult<()> {
        let now = Self::capture(states, &self.group)?;
        if now.host != self.host
            || now.session != self.session
            || now.connected_at != self.connected_at
        {
            return Err(missing());
        }
        Ok(())
    }
}
fn missing() -> AppError {
    AppError::validation("ssh.sessionMissing")
}
struct Authority {
    context: HostContext,
    target: Target,
    identity: SessionIdentity,
    handle: Arc<russh::client::Handle<ClientHandler>>,
    origin: Option<Origin>,
    invocation: Option<InvocationFence>,
}
impl Policy for Authority {
    fn check(&self) -> AppResult<()> {
        let check = || {
            let state = self.context.app.state::<AppState>();
            state
                .plugins
                .security
                .with_authorized(&lease(&self.context), &["mounts.read"], || {
                    let read = || {
                        self.target
                            .recheck(&state.mount_runtime.connection_states())?;
                        if state.ssh.identity(&self.target.session)? != self.identity
                            || !Arc::ptr_eq(&state.ssh.handle(&self.target.session)?, &self.handle)
                        {
                            return Err(missing());
                        }
                        Ok(())
                    };
                    match &self.invocation {
                        Some(fence) => fence.with_live(read),
                        None => read(),
                    }
                })
        };
        match &self.origin {
            Some(origin) => origin.with_current(check),
            None => check(),
        }
    }
}
pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let query = match method {
        "paths.remote.resolve" => Query::Resolve {
            path: optional(&params, "path")?,
        },
        "paths.remote.browse" => Query::Browse {
            path: optional(&params, "path")?,
            offset: optional(&params, "offset")?.unwrap_or(0),
        },
        _ => return Err(AppError::validation("plugin.api.unknownMethod")),
    };
    query.validate()?;
    let state = context.app.state::<AppState>();
    let target = Target::capture(
        &state.mount_runtime.connection_states(),
        &field::<String>(&params, "groupId")?,
    )?;
    let identity = state.ssh.identity(&target.session)?;
    let handle = state.ssh.handle(&target.session)?;
    let authority = Authority {
        context: context.clone(),
        target,
        identity,
        handle: handle.clone(),
        origin: origin::current(),
        invocation: crate::plugins::current_invocation_fence(),
    };
    directory::query(handle, query, authority).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_target_never_follows_a_reconnected_or_moved_group() {
        let initial = ConnectionStatus {
            group_id: "group".into(),
            host_id: "host".into(),
            session_id: Some("session".into()),
            phase: "connected".into(),
            connected_at: Some(1),
            ..Default::default()
        };
        let target = Target::capture(std::slice::from_ref(&initial), "group").unwrap();
        target.recheck(std::slice::from_ref(&initial)).unwrap();
        for field in 0..5 {
            let mut other = initial.clone();
            match field {
                0 => other.group_id = "other".into(),
                1 => other.host_id = "other".into(),
                2 => other.session_id = Some("replacement".into()),
                3 => other.connected_at = Some(2),
                _ => other.phase = "retrying".into(),
            }
            assert!(target.recheck(&[other]).is_err());
        }
        assert!(target.recheck(&[]).is_err());
    }
}
