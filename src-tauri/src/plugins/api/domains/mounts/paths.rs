use super::HostContext;
use crate::{
    error::{AppError, AppResult},
    plugins::api::{authorize, field, optional},
    services::{
        mounts::{contract, repository},
        operations::{Budget, Errors},
    },
    state::AppState,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::LazyLock};
use tauri::Manager;

pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "paths.remote.browse" | "paths.remote.resolve" => {
            let group_id: String = field(&params, "groupId")?;
            let status = state
                .mount_runtime
                .connection_states()
                .into_iter()
                .find(|s| s.group_id == group_id && s.phase == "connected")
                .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
            let session = status
                .session_id
                .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
            let path: Option<String> = optional(&params, "path")?;
            if path
                .as_ref()
                .is_some_and(|p| p.len() > 2048 || p.contains(['\0', '\r', '\n']))
            {
                return Err(AppError::validation("mounts.remotePath.invalid"));
            }
            if method == "paths.remote.resolve" {
                return crate::ssh::files::remote_resolve_directory(app, &session, path).await;
            }
            let listing = crate::ssh::files::remote_list(app, &session, path).await?;
            let entries: Vec<_> = listing.entries.into_iter().filter(|e| e.is_dir).collect();
            let offset: usize = optional(&params, "offset")?.unwrap_or(0);
            let next_offset =
                (entries.len().saturating_sub(offset) > 128).then_some(offset.saturating_add(128));
            authorize(context, &["mounts.read"])?;
            Ok(
                json!({"path":listing.path,"entries":entries.into_iter().skip(offset).take(128).collect::<Vec<_>>(),"nextOffset":next_offset}),
            )
        }
        "paths.local.pick" => {
            #[cfg(windows)]
            {
                let drive: Option<String> = optional(&params, "drive")?;
                let drive = drive.unwrap_or_else(|| "X:\\".into());
                contract::validate_local_path(&drive)?;
                let message = format!("Use {drive} as the mount point?");
                let confirmed = crate::plugins::api::frontend_request(
                    context,
                    "ui.confirm",
                    json!({"message":message}),
                )
                .await?;
                if confirmed != true {
                    return Ok(Value::Null);
                }
                validate(context, drive).await
            }
            #[cfg(not(windows))]
            {
                let title = if state.locale().starts_with("zh") {
                    "选择挂载目录"
                } else {
                    "Choose mount directory"
                }
                .to_owned();
                let picked = if let Some(origin) =
                    crate::platform::panel_windows::plugin_views::origin::current()
                {
                    crate::platform::panel_windows::plugin_views::pickers::pick_folder(
                        app, origin, title,
                    )
                    .await?
                } else {
                    crate::commands::plugin_pick_folder(app.clone(), Some(title)).await?
                };
                authorize(context, &["mounts.write"])?;
                match picked {
                    Some(path) => validate(context, path).await,
                    None => Ok(Value::Null),
                }
            }
        }
        "paths.local.validate" => validate(context, field(&params, "path")?).await,
        "paths.conflicts" => {
            let path: String = field(&params, "path")?;
            contract::validate_local_path(&path)?;
            let exclude: Option<String> = optional(&params, "excludeRuleId")?;
            let rules = state.db.with(|conn| {
                repository::all::<crate::services::mounts::contract::Rule>(conn, None)
            })?;
            let active = state.mounts.list(None).await;
            // One bounded worker and one deadline cover the complete query.
            // A stalled FUSE canonicalization must retain its worker permit.
            static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
                Budget::new(
                    4,
                    Errors {
                        domain: "mounts.paths.conflicts",
                        busy: "mounts.pathBusy",
                        cancelled: "mounts.pathTimeout",
                        failed: "mounts.pathTimeout",
                    },
                )
            });
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), WORKERS.blocking(move |cancel| {
                let root = canonical_sync(path);
                let mut conflicts = Vec::new();
                for rule in rules {
                    cancel.check()?;
                    if exclude.as_deref() == Some(&rule.value.id) { continue; }
                    if overlaps(&root, &canonical_sync(rule.value.mount_point.clone())) {
                        conflicts.push(json!({"kind":"rule","id":rule.value.id,"hostId":rule.value.host_id,"path":rule.value.mount_point}));
                    }
                }
                for mount in active {
                    cancel.check()?;
                    if overlaps(&root, &canonical_sync(mount.mount_point.clone())) {
                        conflicts.push(json!({"kind":"runtime","id":mount.id,"path":mount.mount_point}));
                    }
                }
                let total = conflicts.len();
                conflicts.truncate(128);
                Ok(json!({"path":root,"conflicts":conflicts,"total":total,"truncated":total>128}))
            })).await.map_err(|_| AppError::validation("mounts.pathTimeout"))??;
            authorize(context, &["mounts.read"])?;
            Ok(result)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
fn overlaps(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        let a = std::path::Path::new(a);
        let b = std::path::Path::new(b);
        a.starts_with(b) || b.starts_with(a)
    }
}
fn canonical_sync(path: String) -> String {
    if cfg!(windows) {
        return path.to_ascii_uppercase();
    }
    PathBuf::from(&path)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}
async fn canonical(path: String) -> AppResult<String> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "mounts.paths",
                busy: "mounts.pathBusy",
                cancelled: "mounts.pathTimeout",
                failed: "mounts.pathTimeout",
            },
        )
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        WORKERS.blocking(move |cancel| {
            cancel.check()?;
            Ok(canonical_sync(path))
        }),
    )
    .await
    .map_err(|_| AppError::validation("mounts.pathTimeout"))?
}
async fn validate(context: &HostContext, path: String) -> AppResult<Value> {
    contract::validate_local_path(&path)?;
    let root = canonical(path).await?;
    let path = root.clone();
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "mounts.paths.validate",
                busy: "mounts.pathBusy",
                cancelled: "mounts.pathTimeout",
                failed: "mounts.pathTimeout",
            },
        )
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        WORKERS.blocking(move |cancel| {
            cancel.check()?;
            if cfg!(windows) {
                if PathBuf::from(&path).exists() {
                    return Err(AppError::validation(
                        "mounts.mountPoint.unusedDriveRequired",
                    ));
                }
            } else if !PathBuf::from(&path).is_dir() || std::fs::read_dir(&path)?.next().is_some() {
                return Err(AppError::validation(
                    "mounts.mountPoint.emptyDirectoryRequired",
                ));
            }
            cancel.check()?;
            Ok(())
        }),
    )
    .await
    .map_err(|_| AppError::validation("mounts.pathTimeout"))??;
    authorize(context, &[])?;
    Ok(json!({"path":root,"valid":true}))
}
