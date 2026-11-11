use super::{super::Record, presentation, Kind};
use crate::ssh::session::SessionIdentity;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

fn dialogs() -> &'static Arc<tokio::sync::Semaphore> {
    static DIALOGS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    DIALOGS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

pub(super) async fn ask(
    app: &AppHandle,
    id: &str,
    record: &Record,
    actual: &SessionIdentity,
    kind: Kind,
    fingerprint: &str,
) -> AppResult<bool> {
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, explanation, yes, no) = match (kind, chinese) {
        (Kind::Destination, true) => ("确认旧任务的原目标", "旧记录没有连接身份。只有确定下方连接是这些文件和任务原本所属的机器，才确认绑定。此操作不启动或重放任务，也不删除远端文件；错误绑定可能使后续检查和停止落到其他机器。", "确认原目标", "取消"),
        (Kind::Destination, false) => ("Confirm the original task destination", "The older record has no connection identity. Bind only if this connection is the original machine that owns these files and tasks. This does not start or replay work or delete remote files. An incorrect binding could direct later inspection and stopping to another machine.", "Confirm original destination", "Cancel"),
        (Kind::Control, true) => ("交接旧任务的控制权", "允许当前已授权插件控制此前版本启动的这个持久任务。原远端代码和权限范围不会自动更新。此操作不清除停止请求，不发送提示词，也不启动任务。确认前请核对原任务和插件。", "交接控制权", "取消"),
        (Kind::Control, false) => ("Hand over control of the previous task", "Allow the currently authorized plugin to control this durable task launched by an earlier package. Its remote code and scope are not automatically updated. This does not clear stop requests, send prompts or start work. Review the task and package before confirming.", "Hand over control", "Cancel"),
    };
    let message = format!(
        "{explanation}\n\n{}",
        presentation::review(chinese, id, record, actual, kind, fingerprint)
    );
    confirm(app, title, message, yes, no).await
}

pub(in crate::plugins::runners) async fn stop(
    app: &AppHandle,
    id: &str,
    record: &Record,
) -> AppResult<bool> {
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, text, yes, no) = if chinese {
        ("请求停止远端持久任务？", "停止意图会先保存，再通过原目标的可用连接重试。断线或响应丢失不代表任务已退出；远端文件会保留。", "请求停止", "取消")
    } else {
        ("Request stopping the durable remote task?", "The stop intent is saved first, then retried through available connections to the original destination. Disconnects or lost responses do not prove exit. Remote files are preserved.", "Request stop", "Cancel")
    };
    confirm(
        app,
        title,
        format!(
            "{text}\n\n{}\n{}",
            presentation::record(chinese, id, record),
            presentation::field(
                chinese,
                ("Destination", "目标"),
                record
                    .deployment
                    .identity
                    .as_ref()
                    .map(|value| value.address.as_str())
                    .unwrap_or(if chinese {
                        "待核对的旧目标"
                    } else {
                        "Unreviewed legacy identity"
                    }),
                512
            )
        ),
        yes,
        no,
    )
    .await
}

async fn confirm(
    app: &AppHandle,
    title: &str,
    message: String,
    yes: &str,
    no: &str,
) -> AppResult<bool> {
    let permit = dialogs()
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.runners.reviewBusy"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
            drop(permit);
        });
    tokio::time::timeout(Duration::from_secs(120), receiver)
        .await
        .map_err(|_| AppError::validation("plugin.runners.reviewExpired"))?
        .map_err(|_| AppError::validation("plugin.runners.reviewClosed"))
}

pub(in crate::plugins::runners) async fn forget(
    app: &AppHandle,
    id: &str,
    record: &Record,
) -> AppResult<bool> {
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, text, yes, no) = if record.runner_id == "deployment" && chinese {
        ("移除尚未提交的部署记录？", "这条记录尚未提交远端创建请求。仅移除本地预留记录；不会删除远端内容。正在准备的请求会因记录已变更而终止。", "移除记录", "取消")
    } else if record.runner_id == "deployment" {
        ("Remove the unsubmitted deployment record?", "No remote creation request has been submitted for this reservation. Remove only the local record; remote content is preserved. A preparing request will stop because its record has changed.", "Remove record", "Cancel")
    } else if chinese {
        (
            "移除已结束任务的本地记录？",
            "仅移除这条本地恢复记录，不删除远端文件，也不会停止其他任务。",
            "移除记录",
            "取消",
        )
    } else {
        (
            "Remove the completed task record?",
            "Remove only this local recovery record. Remote files and other tasks are preserved.",
            "Remove record",
            "Cancel",
        )
    };
    confirm(
        app,
        title,
        format!("{text}\n\n{}", presentation::record(chinese, id, record)),
        yes,
        no,
    )
    .await
}
