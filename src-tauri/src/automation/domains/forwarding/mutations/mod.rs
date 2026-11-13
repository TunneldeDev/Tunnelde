//! Explicit user consent followed by shared-domain CAS, never an internal IPC
//! passthrough. Network starts use a separate host-credential interaction flow.
mod consent;
mod contract;
mod schema;
#[cfg(test)]
pub(super) mod tests;
use crate::{automation::contract::Failure, error::AppError, services::forwarding};
use contract::Mutation;
use forwarding::contract::RevisionedInfo;
pub(in super::super) use schema::methods;
use serde_json::{json, Value};
use tauri::AppHandle;

fn map_error(error: AppError) -> Failure {
    match error.original() {
        AppError::Validation(reason) if reason == "forward.changed" => Failure::new(
            "stale_revision",
            "The forwarding rule or running instance changed; read forwards.list and review again",
        ),
        AppError::Validation(reason) if reason == "forward.stopBeforeEdit" => Failure::new(
            "operation_rejected",
            "Stop the running rule before changing or removing it",
        ),
        _ => {
            tracing::warn!(target: "automation.forwards", error_code=error.code(), "Local forwarding mutation failed; no automatic retry");
            Failure::new("operation_rejected", "Cannot complete the forwarding operation; inspect application logs and read current status before retrying")
        }
    }
}
fn review(mutation: &Mutation, current: Option<&RevisionedInfo>) -> Result<(), Failure> {
    match (mutation.revision(), current) {
        (None, None) => Ok(()),
        (Some(expected), Some(current)) if expected == current.revision => {
            if matches!(mutation, Mutation::Save { .. } | Mutation::Remove { .. })
                && current.runtime_id.is_some()
            {
                return Err(Failure::new(
                    "operation_rejected",
                    "Stop the running rule before changing or removing it",
                ));
            }
            if matches!(mutation, Mutation::Stop { .. }) && current.runtime_id.is_none() {
                return Err(Failure::new(
                    "operation_rejected",
                    "This forwarding rule has no running instance",
                ));
            }
            Ok(())
        }
        _ => Err(Failure::new(
            "stale_revision",
            "The forwarding rule changed; read forwards.list before retrying",
        )),
    }
}
fn reply(mutation: &Mutation, outcome: &str, revision: Option<&str>) -> Value {
    json!({"outcome":outcome,"id":mutation.id(),"revision":revision})
}
pub(super) async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    let mutation = contract::parse(method, params)?;
    let current = forwarding::find(app, mutation.id()).map_err(map_error)?;
    review(&mutation, current.as_ref())?;
    let permit = consent::admit()?;
    if !consent::confirm(app, &mutation, current.as_ref(), permit).await? {
        return Ok(reply(&mutation, "dismissed", mutation.revision()));
    }
    // No suspension between consent and each metadata commit. A late callback
    // only sends a boolean to a dropped receiver; it cannot perform any write.
    match &mutation {
        Mutation::Save { rule, revision } => {
            let saved = if let Some(revision) = revision {
                forwarding::save_checked(app, rule.clone(), Some(revision))
            } else {
                forwarding::create(app, rule.clone())
            }
            .map_err(map_error)?;
            Ok(reply(&mutation, mutation.outcome(), Some(&saved.revision)))
        }
        Mutation::Remove { id, revision } => {
            forwarding::remove_inactive_checked(app, id, revision).map_err(map_error)?;
            Ok(reply(&mutation, mutation.outcome(), Some(revision)))
        }
        Mutation::Stop { id, revision } => {
            let runtime = current
                .as_ref()
                .and_then(|entry| entry.runtime_id.as_deref())
                .expect("reviewed running instance");
            let stopping =
                forwarding::take_checked(app, id, revision, runtime).map_err(map_error)?;
            // Cleanup has its own owner before awaiting; caller loss does not
            // resurrect the detached instance or target a newer one.
            stopping.finish().await.map_err(map_error)?;
            Ok(reply(&mutation, mutation.outcome(), Some(revision)))
        }
    }
}
