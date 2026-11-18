//! Bounded, inspectable batch receipts. Cancellation prevents subsequent steps;
//! it never pretends an already committed filesystem operation was rolled back.
use super::{
    contract::{Entry, Group, Rule},
    repository,
    runtime::{self, Authority},
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
pub(crate) enum Step {
    Connect(Entry<Group>),
    Disconnect(Entry<Group>),
    Start(Entry<Rule>),
    Stop {
        rule: Entry<Rule>,
        runtime_id: Option<String>,
    },
    RemoveRule(Entry<Rule>),
    RemoveGroup(Entry<Group>, Vec<(String, String)>),
}
impl Step {
    fn id(&self) -> &str {
        match self {
            Self::Connect(g) | Self::Disconnect(g) | Self::RemoveGroup(g, _) => &g.value.id,
            Self::Start(r) | Self::RemoveRule(r) | Self::Stop { rule: r, .. } => &r.value.id,
        }
    }
    fn group(&self) -> &str {
        match self {
            Self::Connect(g) | Self::Disconnect(g) | Self::RemoveGroup(g, _) => &g.value.id,
            Self::Start(r) | Self::RemoveRule(r) | Self::Stop { rule: r, .. } => &r.value.group_id,
        }
    }
}
#[derive(Default)]
struct Dependencies {
    groups: HashSet<String>,
    rules: HashSet<String>,
}
impl Dependencies {
    fn blocked(&self, step: &Step) -> bool {
        matches!(step, Step::Connect(_) | Step::Start(_))
            && (self.groups.contains(step.group()) || self.rules.contains(step.id()))
    }
    fn failed(&mut self, step: &Step) {
        if matches!(step, Step::Connect(_) | Step::Disconnect(_)) {
            self.groups.insert(step.group().into());
        }
        if matches!(step, Step::Stop { .. }) {
            self.rules.insert(step.id().into());
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub target_id: String,
    pub phase: String,
    pub error: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub kind: String,
    pub phase: String,
    pub revision: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub items: Vec<Item>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub(crate) id: String,
    kind: String,
    phase: String,
    revision: String,
    created_at: i64,
    updated_at: i64,
    total: usize,
    completed: usize,
    failed: usize,
}
/// Native diagnostics can contain arbitrary remote output. Receipts stay bounded.
pub(crate) fn error_value(error: &AppError) -> serde_json::Value {
    let mut value = serde_json::to_value(error).unwrap_or_default();
    let message = error.to_string();
    let category = if message.contains("authFailed")
        || message.contains("passwordRequired")
        || message.contains("keyLoad")
    {
        "authentication"
    } else if message.contains("hostKey") {
        "trust"
    } else if message.contains("connectionChanged") || message.contains("network.invalid") {
        "route"
    } else if message.contains("dependencies") {
        "dependency"
    } else if message.contains("cleanup") || message.contains("unmount") {
        "cleanup"
    } else if message.contains("changed")
        || message.contains("busy")
        || message.contains("conflict")
        || message.contains("inUse")
    {
        "conflict"
    } else if matches!(error.original(), AppError::Io(_) | AppError::Ssh(_))
        || message.contains("transportClosed")
    {
        "transport"
    } else if matches!(
        error.original(),
        AppError::Validation(_) | AppError::NotFound(_)
    ) {
        "validation"
    } else {
        "internal"
    };
    if serde_json::to_vec(&value).map_or(true, |raw| raw.len() > 1024) {
        value = serde_json::json!({"code":"internal","message":"mounts.operations.failed"});
    }
    value["category"] = category.into();
    value["retryable"] = runtime::retryable(error).into();
    value
}
struct Operation {
    info: Info,
    cancelled: Arc<AtomicBool>,
    owner: Option<String>,
}
#[derive(Default)]
pub(crate) struct Registry(Mutex<BTreeMap<String, Operation>>);
impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Operation>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn list(&self) -> Vec<Summary> {
        self.lock()
            .values()
            .map(|o| Summary {
                id: o.info.id.clone(),
                kind: o.info.kind.clone(),
                phase: o.info.phase.clone(),
                revision: o.info.revision.clone(),
                created_at: o.info.created_at,
                updated_at: o.info.updated_at,
                total: o.info.items.len(),
                completed: o.info.items.iter().filter(|i| !running(&i.phase)).count(),
                failed: o
                    .info
                    .items
                    .iter()
                    .filter(|i| matches!(i.phase.as_str(), "failed" | "blocked"))
                    .count(),
            })
            .collect()
    }
    pub(crate) fn get(&self, id: &str) -> AppResult<Info> {
        self.lock()
            .get(id)
            .map(|o| o.info.clone())
            .ok_or_else(|| AppError::NotFound("mounts.operations.notFound".into()))
    }
    pub(crate) fn cancel(&self, id: &str) -> AppResult<Info> {
        let mut ops = self.lock();
        let op = ops
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound("mounts.operations.notFound".into()))?;
        if running(&op.info.phase) {
            op.cancelled.store(true, Ordering::Release);
            op.info.revision = uuid::Uuid::new_v4().to_string();
        }
        Ok(op.info.clone())
    }
    pub(crate) fn cancel_all(&self) {
        for operation in self.lock().values() {
            operation.cancelled.store(true, Ordering::Release);
        }
    }
}
fn running(phase: &str) -> bool {
    matches!(phase, "pending" | "running")
}
fn publish(app: &AppHandle, info: &Info) {
    let _ = app.emit(
        "mounts://operation-changed",
        serde_json::json!({"id":info.id,"revision":info.revision}),
    );
    runtime::changed(app);
}
fn update(app: &AppHandle, id: &str, action: impl FnOnce(&mut Info)) {
    let state = app.state::<AppState>();
    let mut ops = state.mount_runtime.operations.lock();
    if let Some(operation) = ops.get_mut(id) {
        action(&mut operation.info);
        operation.info.revision = uuid::Uuid::new_v4().to_string();
        operation.info.updated_at = crate::models::now_ms();
        publish(app, &operation.info);
    }
}
pub(crate) fn submit(
    app: &AppHandle,
    kind: &str,
    steps: Vec<Step>,
    authority: Authority,
) -> AppResult<Info> {
    authority.check(app)?;
    let state = app.state::<AppState>();
    if state.mount_runtime.shutting_down.load(Ordering::Acquire) {
        return Err(AppError::validation("mounts.operations.cancelled"));
    }
    if steps.len() > 256 {
        return Err(AppError::validation("mounts.rules.limit"));
    }
    let owner = authority.0.as_ref().map(|lease| lease.id.clone());
    let mut ops = state.mount_runtime.operations.lock();
    if ops.values().filter(|op| running(&op.info.phase)).count() >= 8
        || ops
            .values()
            .filter(|op| running(&op.info.phase) && op.owner == owner)
            .count()
            >= 4
    {
        return Err(AppError::validation("mounts.operations.busy"));
    }
    while ops.len() >= 128 {
        let oldest = ops
            .values()
            .filter(|op| !running(&op.info.phase))
            .min_by_key(|op| op.info.updated_at)
            .map(|op| op.info.id.clone());
        if let Some(id) = oldest {
            ops.remove(&id);
        } else {
            return Err(AppError::validation("mounts.operations.busy"));
        }
    }
    let info = Info {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        phase: "pending".into(),
        revision: uuid::Uuid::new_v4().to_string(),
        created_at: crate::models::now_ms(),
        updated_at: crate::models::now_ms(),
        items: steps
            .iter()
            .map(|step| Item {
                target_id: step.id().into(),
                phase: "pending".into(),
                error: None,
            })
            .collect(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    ops.insert(
        info.id.clone(),
        Operation {
            info: info.clone(),
            cancelled: cancel.clone(),
            owner,
        },
    );
    drop(ops);
    publish(app, &info);
    let handle = app.clone();
    let id = info.id.clone();
    tauri::async_runtime::spawn(async move {
        update(&handle, &id, |info| info.phase = "running".into());
        let mut failures = 0;
        let mut dependencies = Dependencies::default();
        for (index, step) in steps.into_iter().enumerate() {
            if cancel.load(Ordering::Acquire)
                || authority.check(&handle).is_err()
                || handle
                    .state::<AppState>()
                    .mount_runtime
                    .shutting_down
                    .load(Ordering::Acquire)
            {
                update(&handle, &id, |info| {
                    info.phase = "cancelled".into();
                    for item in &mut info.items[index..] {
                        item.phase = "cancelled".into();
                    }
                });
                return;
            }
            update(&handle, &id, |info| {
                info.items[index].phase = "running".into()
            });
            let blocked = dependencies.blocked(&step);
            let result = if blocked {
                Err(AppError::validation("mounts.operations.dependencyFailed"))
            } else {
                execute(&handle, step.clone(), &authority).await
            };
            if result.is_err() {
                dependencies.failed(&step);
            }
            if result.is_err() {
                failures += 1;
            }
            update(&handle, &id, |info| {
                info.items[index].phase = if result.is_ok() {
                    "succeeded"
                } else if blocked {
                    "blocked"
                } else {
                    "failed"
                }
                .into();
                info.items[index].error = result.err().map(|e| error_value(&e));
            });
        }
        update(&handle, &id, |info| {
            info.phase = if failures == 0 {
                "succeeded"
            } else if failures == info.items.len() {
                "failed"
            } else {
                "partial"
            }
            .into()
        });
    });
    Ok(info)
}
async fn execute(app: &AppHandle, step: Step, authority: &Authority) -> AppResult<()> {
    let state = app.state::<AppState>();
    let _gate = state.mount_runtime.gate(step.group())?;
    authority.check(app)?;
    // Every queued step binds the exact saved revision observed at submission.
    state.db.with(|conn| {
        let matches = match &step {
            Step::Connect(g) | Step::Disconnect(g) | Step::RemoveGroup(g, _) => {
                repository::get::<Group>(conn, &g.value.id)?
                    .is_some_and(|saved| saved.revision == g.revision)
            }
            Step::Start(r) | Step::RemoveRule(r) | Step::Stop { rule: r, .. } => {
                repository::get::<Rule>(conn, &r.value.id)?
                    .is_some_and(|saved| saved.revision == r.revision)
            }
        };
        if matches {
            Ok(())
        } else {
            Err(repository::changed())
        }
    })?;
    match step {
        Step::Connect(group) => {
            runtime::connect(app, &group, authority).await?;
        }
        Step::Disconnect(group) => runtime::disconnect(app, &group, authority).await?,
        Step::Start(rule) => {
            runtime::start(app, &rule, authority).await?;
        }
        Step::Stop { rule, runtime_id } => {
            runtime::stop(app, &rule.value.id, runtime_id.as_deref(), authority).await?
        }
        Step::RemoveRule(rule) => {
            runtime::stop(app, &rule.value.id, None, authority).await?;
            authority.commit(app, || {
                state.db.with(|conn| {
                    crate::db::atomic(conn, |conn| {
                        repository::remove::<Rule>(conn, &rule.value.id, &rule.revision)
                    })
                })
            })?;
            state.mount_runtime.forget_rule(&rule.value.id);
            runtime::changed(app);
        }
        Step::RemoveGroup(group, confirmed_rules) => {
            state.db.with(|conn| {
                let current = repository::all::<Rule>(conn, Some(&group.value.host_id))?
                    .into_iter()
                    .filter(|rule| rule.value.group_id == group.value.id)
                    .map(|rule| (rule.value.id, rule.revision));
                if !current.eq(confirmed_rules) {
                    return Err(repository::changed());
                }
                Ok(())
            })?;
            runtime::disconnect(app, &group, authority).await?;
            authority.commit(app, || {
                state.db.with(|conn| {
                    crate::db::atomic(conn, |conn| {
                        repository::remove::<Group>(conn, &group.value.id, &group.revision)
                    })
                })
            })?;
            state.mount_runtime.forget_group(&group.value.id);
            runtime::changed(app);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn group(id: &str) -> Entry<Group> {
        Entry {
            revision: "v1".into(),
            value: Group {
                id: id.into(),
                host_id: "h".into(),
                name: id.into(),
                auto_reconnect: true,
            },
        }
    }
    fn rule(id: &str, group: &str) -> Entry<Rule> {
        Entry {
            revision: "v1".into(),
            value: Rule {
                id: id.into(),
                host_id: "h".into(),
                group_id: group.into(),
                name: id.into(),
                remote_path: "/src".into(),
                mount_point: "/tmp/mount".into(),
                read_only: true,
                auto_mount: false,
            },
        }
    }
    #[test]
    fn failed_group_blocks_only_its_dependents_and_failed_stop_blocks_restart() {
        let mut deps = Dependencies::default();
        deps.failed(&Step::Connect(group("a")));
        assert!(deps.blocked(&Step::Start(rule("one", "a"))));
        assert!(!deps.blocked(&Step::Start(rule("two", "b"))));
        assert!(!deps.blocked(&Step::Stop {
            rule: rule("one", "a"),
            runtime_id: None
        }));
        deps.failed(&Step::Stop {
            rule: rule("two", "b"),
            runtime_id: None,
        });
        assert!(deps.blocked(&Step::Start(rule("two", "b"))));
        assert!(!deps.blocked(&Step::Start(rule("three", "b"))));
        deps.failed(&Step::Start(rule("three", "b")));
        assert!(!deps.blocked(&Step::Start(rule("four", "b"))));
    }
    #[test]
    fn receipt_errors_are_bounded_and_classified() {
        let error = error_value(&AppError::Ssh("ssh.hostKeyChanged".into()));
        assert_eq!(error["category"], "trust");
        assert_eq!(error["retryable"], false);
        let error = error_value(&AppError::Ssh("x".repeat(100_000)));
        assert!(serde_json::to_vec(&error).unwrap().len() < 1500);
    }
}
