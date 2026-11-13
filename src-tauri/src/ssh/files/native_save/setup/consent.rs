//! Native host confirmation; plugins cannot replace the reviewed destination.
use super::preparation::Prepared;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub(super) async fn ask(prepared: &Prepared) -> AppResult<bool> {
    static DIALOG: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = DIALOG
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("editor.nativeBusy"))?;
    prepared.verify()?;
    let app = &prepared.remote.app;
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, yes, no) = if chinese {
        ("为此目录启用安全保存？", "安装并初始化", "取消")
    } else {
        (
            "Enable recoverable saves for this folder?",
            "Install and initialize",
            "Cancel",
        )
    };
    let plan = &prepared.plan;
    let local = app
        .state::<AppState>()
        .native_saves
        .directory()
        .to_path_buf();
    let message = if chinese {
        format!("在当前远端目录安装 Tunnelde 官方可选组件 0.28.0，以便保存中断后查询原结果。\n\n目标：{}\n账号：{}\n目录：{}\n程序：{}\n恢复数据：{}\n本地记录：{}\n下载：{}\n\n将下载并验证组件，在上述位置创建私有目录和恢复数据库，并在系统凭据库保存后续文件操作的恢复凭据。保存可能保留原文件备份，需要明确确认后清理。仅支持本地文件系统；网络挂载可能被拒绝。此步骤不保存正在编辑的文件，不请求管理员权限，不运行后台常驻服务。中断后的未知安装记录会保留。", plan.destination.address, plan.context.account, plan.context.scope, plan.selection.executable, plan.selection.directory, local.display(), prepared.package.url())
    } else {
        format!("Install the official optional Tunnelde helper 0.28.0 for this remote folder, allowing interrupted saves to query their original outcome.\n\nDestination: {}\nAccount: {}\nFolder: {}\nExecutable: {}\nRecovery data: {}\nLocal records: {}\nDownload: {}\n\nDownloads and verifies the helper, creates private directories and recovery databases, and uses the system credential store for subsequent file-operation recovery. Saves may retain an original backup until explicitly discarded. Local filesystems only; network mounts may be rejected. This step does not save the open file, request administrator privileges or run a persistent service. Uncertain installation records are preserved after interruption.", plan.destination.address, plan.context.account, plan.context.scope, plan.selection.executable, plan.selection.directory, local.display(), prepared.package.url())
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |accepted| {
            let _ = sender.send(accepted);
            drop(permit);
        });
    tokio::time::timeout(Duration::from_secs(120), receiver)
        .await
        .map_err(|_| AppError::validation("editor.nativeSetupExpired"))?
        .map_err(|_| AppError::validation("editor.nativeSetupExpired"))
}
