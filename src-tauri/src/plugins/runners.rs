//! Durable optional remote runners. Domain modules own persistence, transport,
//! launch, deployment and recovery; no repository lock spans a network await.
use super::api::{authorize, field, frontend_request, optional, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::{json, Value};
use tauri::Manager;

mod admission;
mod artifacts;
pub(crate) mod bootstrap;
mod capabilities;
mod contracts;
mod coordinator;
mod deployment;
mod identity;
mod lifecycle;
pub mod management;
mod model;
mod operations;
mod repository;
mod review;
mod transport;
pub(crate) use coordinator::Coordinator;
pub use lifecycle::on_reconnect;
pub(super) use lifecycle::revoke_before;
use model::{Deployment, Record};
use transport::exec;

fn path_join(directory: &str, name: &str, platform: &str) -> String {
    format!(
        "{}{}{name}",
        directory.trim_end_matches(['/', '\\']),
        if platform == "windows" { "\\" } else { "/" }
    )
}
fn validate_directory(directory: &str, platform: &str) -> AppResult<()> {
    if directory.is_empty()
        || directory.len() > 4096
        || directory.contains(['\0', '\n', '\r'])
        || directory.split(['/', '\\']).any(|part| part == "..")
        || !(if platform == "windows" {
            directory.as_bytes().get(1) == Some(&b':')
                && directory
                    .as_bytes()
                    .get(2)
                    .is_some_and(|byte| b"/\\".contains(byte))
        } else {
            directory.starts_with('/') && directory != "/"
        })
    {
        return Err(AppError::validation(
            "plugin.runners.absoluteDirectoryRequired",
        ));
    }
    Ok(())
}
fn host_id(context: &HostContext, session: &str) -> AppResult<String> {
    context
        .app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|info| info.id == session)
        .map(|info| info.host_id)
        .ok_or_else(|| AppError::validation("ssh.sessionMissing"))
}

pub async fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let origin = crate::platform::panel_windows::plugin_views::origin::current();
    if method == "runners.list" {
        let staged = crate::plugins::frontend::native::CallPolicy::StagedData;
        let worker = context.clone();
        let origin = origin.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let check = || {
                authorize(&worker, &["ssh.exec"])?;
                if let Some(origin) = &origin {
                    origin.authorize_call(staged)?;
                }
                Ok::<(), AppError>(())
            };
            check()?;
            let value = json!(repository::read(&worker)?
                .iter()
                .filter(|record| record.deployment_ready())
                .map(contracts::Snapshot::from)
                .collect::<Vec<_>>());
            check()?;
            Ok(value)
        })
        .await
        .map_err(|_| AppError::internal("plugin.runners.unavailable"))?;
    }
    let check = || {
        authorize(context, &["ssh.exec"])?;
        if let Some(origin) = &origin {
            origin.authorize_call(crate::plugins::frontend::native::CallPolicy::RunnerEffect)?;
        }
        Ok::<(), AppError>(())
    };
    check()?;
    let result = match method {
        "runners.deploy" => deployment::deploy_with_origin(context, params, origin.clone()).await,
        "runners.start" => {
            operations::start_with_origin(context, params, false, origin.clone()).await
        }
        "runners.startInitialized" => {
            operations::start_with_origin(context, params, true, origin.clone()).await
        }
        "runners.review" => review::dispatch(context, params).await,
        _ => operations::action(context, method, params).await,
    };
    if result.is_ok() {
        check()?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_traversal() {
        for path in ["/", "../x", "/tmp/../x"] {
            assert!(validate_directory(path, "posix").is_err());
        }
        assert!(validate_directory("/home/user/tunnelde-agent", "posix").is_ok());
        assert!(validate_directory("C:\\AgentData\\test\\agent", "windows").is_ok());
    }
}
