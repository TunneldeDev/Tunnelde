//! Native and ordinary transports share the real host service and publication.
//! Admission is injected only around the actual DB mutation; no audit/SSH/OS
//! effect runs under origin or plugin-policy locks.
use super::{lease, HostContext};
use crate::{
    db::Database,
    error::{AppError, AppResult},
    plugins::{
        api::{encode, field},
        security::{Lease, PluginSecurity},
    },
    services::{
        hosts::{Effects, Hosts, WriteAdmission},
        operations::{Authority, Budget, Cancellation, Errors},
    },
    state::AppState,
};
use rusqlite::Connection;
use serde_json::Value;
use std::sync::LazyLock;
use tauri::Manager;

const WRITE: &[&str] = &["hosts.write"];
struct Checked<'a> {
    db: &'a Database,
    security: &'a PluginSecurity,
    lease: &'a Lease,
    cancel: &'a Cancellation,
    authority: Option<&'a dyn Authority>,
}
impl WriteAdmission for Checked<'_> {
    fn with<T>(&self, operation: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.security.with_authorized_fenced_database(
            self.db,
            self.lease,
            WRITE,
            || self.cancel.check(),
            self.authority,
            |conn| {
                self.cancel.commit()?;
                operation(conn)
            },
        )
    }
}
async fn worker<T: Send + 'static>(
    run: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    // CRUD cannot monopolize plugin security-control or read-admission budgets.
    static WRITERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "hosts.mutation",
                busy: "hosts.mutation.busy",
                cancelled: "hosts.mutation.cancelled",
                failed: "hosts.mutation.unavailable",
            },
        )
    });
    WRITERS.blocking(run).await
}
pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let context = context.clone();
    let method = method.to_owned();
    let origin = crate::platform::panel_windows::plugin_views::origin::current();
    worker(move |cancel| {
        let state = context.app.state::<AppState>();
        let lease = lease(&context);
        let checked = Checked {
            db: &state.db,
            security: &state.plugins.security,
            lease: &lease,
            cancel,
            authority: origin.as_ref().map(|o| o as &dyn Authority),
        };
        let hosts = crate::services::hosts::service(&context.app, &state).admitted(checked);
        execute(&hosts, &method, params)
    })
    .await
}
fn execute<E: Effects, A: WriteAdmission>(
    hosts: &Hosts<'_, E, A>,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "hosts.create" => encode(hosts.create(field(&params, "input")?)?),
        "hosts.update" => {
            encode(hosts.update(&field::<String>(&params, "id")?, field(&params, "input")?)?)
        }
        "hosts.delete" => {
            hosts.delete(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.markUsed" => {
            hosts.mark_used(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.reorder" => {
            hosts.reorder(&field::<Vec<String>>(&params, "ids")?)?;
            Ok(Value::Null)
        }
        "groups.create" => encode(hosts.create_group(field(&params, "input")?)?),
        "groups.update" => {
            encode(hosts.update_group(&field::<String>(&params, "id")?, field(&params, "input")?)?)
        }
        "groups.delete" => {
            hosts.delete_group(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
#[cfg(test)]
mod tests;
