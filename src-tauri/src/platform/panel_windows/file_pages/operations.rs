//! Original resource authority follows the actual worker, not the IPC receiver.
use super::*;
use crate::{
    error::AppError,
    services::operations::{Authority, Budget, Errors, WorkLifetime},
    ssh::files::{self, mutations},
    state::AppState,
};
use std::sync::LazyLock;
use tauri::AppHandle;
static LOCAL: LazyLock<Budget> = LazyLock::new(|| Budget::new(8, ERRORS));
static READ: LazyLock<Budget> = LazyLock::new(|| Budget::new(8, ERRORS));
const ERRORS: Errors = Errors {
    domain: "file-page",
    busy: "sftp.localBusy",
    cancelled: "sftp.localCancelled",
    failed: "sftp.localWorkerFailed",
};
pub(super) fn capture_sources(app: &AppHandle, sources: Vec<Source>) -> AppResult<Sources> {
    if sources.is_empty() || sources.len() > 65 {
        return Err(native::invalid("invalid file page sources"));
    }
    let state = app.state::<AppState>();
    let mut result = Sources {
        local: false,
        remote: HashMap::new(),
    };
    for source in sources {
        match source {
            Source::Local {} => result.local = true,
            Source::Remote { session_id } => {
                if uuid::Uuid::parse_str(&session_id).is_err()
                    || !state.ssh.user_managed(&session_id)
                {
                    return Err(AppError::validation("ssh.sessionMissing"));
                }
                let identity = state.ssh.identity(&session_id)?;
                result.remote.insert(session_id, identity);
            }
        }
    }
    Ok(result)
}
struct Call {
    app: AppHandle,
    window: String,
    document: String,
    target: Target,
    binding: Arc<Binding>,
    sources: Vec<Source>,
    fence: Option<(Lease, String)>,
}
impl Call {
    fn with_current<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let registry = self.app.state::<native::Registry>();
        let owner = native::lock(&registry);
        let lease = owner
            .file_page_target(
                &self.window,
                &self.document,
                &self.target,
                &self.binding,
                self.fence.is_some(),
            )
            .map_err(native::invalid)?;
        if let Some((original, id)) = &self.fence {
            if *original != lease
                || !owner
                    .panels
                    .get(&lease.panel_id)
                    .is_some_and(|p| p.native_actions.contains(id))
            {
                return Err(native::invalid("stale file page effect"));
            }
        }
        for source in &self.sources {
            match source {
                Source::Local {} if self.binding.sources.local => {}
                Source::Remote { session_id } => {
                    let expected = self
                        .binding
                        .sources
                        .remote
                        .get(session_id)
                        .ok_or_else(|| native::invalid("unbound file page source"))?;
                    let state = self.app.state::<AppState>();
                    if !state.ssh.user_managed(session_id)
                        || state.ssh.identity(session_id)? != *expected
                    {
                        return Err(AppError::validation("ssh.sessionMissing"));
                    }
                }
                _ => return Err(native::invalid("unbound file page source")),
            }
        }
        // Only short synchronous admission/publication transactions belong here.
        // Never hold this lock across OS/network I/O.
        effect()
    }
}
impl Authority for Call {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        self.with_current(effect)
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Some((lease, id)) = &self.fence {
            native::lock(&self.app.state::<native::Registry>())
                .finish_native_action(&lease.panel_id, id);
            native::changed(&self.app);
        }
    }
}
struct RemotePolicy(Arc<Call>);
impl mutations::Policy for RemotePolicy {
    fn with_authorized(&self, validate: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        self.0.with_current(validate)
    }
}
fn encode<T: Serialize>(value: T) -> AppResult<Value> {
    let result = serde_json::to_value(value).map_err(|_| AppError::internal("file-page.encode"))?;
    if result.to_string().len() > 16 * 1024 * 1024 {
        return Err(AppError::validation("sftp.fileTooLarge"));
    }
    Ok(result)
}
pub(super) async fn execute(
    app: AppHandle,
    window: String,
    document: String,
    target: Target,
    operation: Operation,
) -> AppResult<Value> {
    let registry = app.state::<native::Registry>();
    let (binding, fence) = {
        let mut owner = native::lock(&registry);
        let binding = owner
            .file_page_binding(&window, &document, &target)
            .map_err(native::invalid)?;
        let fence = if operation.mutation() {
            Some(
                owner
                    .begin_file_page_effect(&window, &document, &target, &binding)
                    .map_err(native::invalid)?,
            )
        } else {
            None
        };
        (binding, fence)
    };
    let call = Arc::new(Call {
        app: app.clone(),
        window,
        document,
        target,
        binding,
        sources: operation.sources().into_iter().cloned().collect(),
        fence,
    });
    call.with_current(|| Ok(()))?;
    let work = WorkLifetime::authorized(call.clone());
    // The worker, nested budget jobs and remote mutation policy retain this exact
    // origin and its fence even if the caller drops delivery or reloads main.
    tauri::async_runtime::spawn(work.scope(async move { run(call, operation).await }))
        .await
        .map_err(|_| AppError::internal("sftp.localWorkerFailed"))?
}
async fn run(call: Arc<Call>, operation: Operation) -> AppResult<Value> {
    let result = match operation {
        Operation::Home {
            source: Source::Local {},
        } => encode(files::home_dir().to_string_lossy().into_owned())?,
        Operation::Home {
            source: Source::Remote { .. },
        } => json!("."),
        Operation::List {
            source: Source::Local {},
            path,
        } => {
            let current = call.clone();
            LOCAL
                .blocking(move |job| {
                    current.with_current(|| job.commit())?;
                    encode(files::local_list(path)?)
                })
                .await?
        }
        Operation::List {
            source: Source::Remote { session_id },
            path,
        } => {
            let current = call.clone();
            READ.asynchronous(move |job| async move {
                current.with_current(|| job.commit())?;
                encode(files::remote_list(&current.app, &session_id, path).await?)
            })
            .await?
        }
        Operation::Mkdir {
            source: Source::Remote { session_id },
            path,
        } => {
            mutations::mkdir(&call.app, &session_id, path, RemotePolicy(call.clone())).await?;
            Value::Null
        }
        Operation::CreateFile {
            source: Source::Remote { session_id },
            path,
        } => {
            mutations::create_file(&call.app, &session_id, path, RemotePolicy(call.clone()))
                .await?;
            Value::Null
        }
        Operation::Remove {
            source: Source::Remote { session_id },
            path,
            ..
        } => {
            mutations::delete(&call.app, &session_id, path, RemotePolicy(call.clone())).await?;
            Value::Null
        }
        Operation::Rename {
            source: Source::Remote { session_id },
            from,
            to,
            overwrite,
        } => {
            mutations::rename(
                &call.app,
                &session_id,
                from,
                to,
                overwrite,
                RemotePolicy(call.clone()),
            )
            .await?;
            Value::Null
        }
        Operation::Copy {
            source,
            from,
            to,
            overwrite,
        } => {
            call.with_current(|| Ok(()))?;
            files::start_panel_transfer(
                call.app.clone(),
                endpoint(source.clone(), from),
                endpoint(source, to),
                false,
                overwrite,
                WorkLifetime::authorized(call.clone()),
            )?
            .wait()
            .await?;
            Value::Null
        }
        Operation::Transfer {
            from_source,
            from_path,
            to_source,
            to_path,
            remove_source,
            overwrite,
        } => {
            call.with_current(|| Ok(()))?;
            let task = files::start_panel_transfer(
                call.app.clone(),
                endpoint(from_source, from_path),
                endpoint(to_source, to_path),
                remove_source,
                overwrite,
                WorkLifetime::authorized(call.clone()),
            )?;
            // Dropping this delivery receipt does not cancel the worker. The
            // registry observation and actual worker both retain the origin.
            json!(task.id)
        }
        local => local_operation(&LOCAL, local).await?,
    };
    // Re-check read delivery after slow work; a retired source must not receive
    // a successor's listing. Mutations already retain their actual worker result.
    call.with_current(|| Ok(()))?;
    Ok(result)
}

fn endpoint(source: Source, path: String) -> files::Endpoint {
    files::Endpoint {
        session: match source {
            Source::Local {} => None,
            Source::Remote { session_id } => Some(session_id),
        },
        path,
    }
}

async fn local_operation(budget: &Budget, operation: Operation) -> AppResult<Value> {
    budget
        .blocking(move |job| {
            WorkLifetime::with_current(|| job.commit())?;
            match operation {
                Operation::Mkdir {
                    source: Source::Local {},
                    path,
                } => files::local_mkdir(path)?,
                Operation::CreateFile {
                    source: Source::Local {},
                    path,
                } => files::local_create_file(path)?,
                Operation::Remove {
                    source: Source::Local {},
                    path,
                    is_dir,
                } => files::local_delete(path, is_dir)?,
                // Atomic rename only. Copy-based cross-volume/merge fallback needs
                // its own retained transfer owner, not an unguarded retry.
                Operation::Rename {
                    source: Source::Local {},
                    from,
                    to,
                    overwrite,
                } => files::local_rename(from, to, overwrite)?,
                _ => return Err(native::invalid("invalid local file operation")),
            }
            Ok(Value::Null)
        })
        .await
}
#[cfg(test)]
mod tests;
