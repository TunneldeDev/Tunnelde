//! A dropped/expired caller cannot commit from the native callback. Its permit
//! stays with the dialog, preventing replacement or accumulation of stale UI.
use super::{contract::Mutation, map_error};
use crate::{automation::contract::Failure, state::AppState};
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

pub(super) const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) fn admit() -> Result<OwnedSemaphorePermit, Failure> {
    static DIALOGS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
    DIALOGS.clone().try_acquire_owned().map_err(|_| {
        Failure::new(
            "operation_rejected",
            "Another local forwarding confirmation is still open",
        )
    })
}
pub(super) async fn confirm(
    app: &AppHandle,
    mutation: &Mutation,
    current: Option<&crate::services::forwarding::contract::RevisionedInfo>,
    permit: OwnedSemaphorePermit,
) -> Result<bool, Failure> {
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, yes, no, explanation) = if chinese {
        (
            "外部程序请求修改转发",
            "确认",
            "取消",
            "本机程序通过 Tunnelde 本地 API 发起此操作。请核对完整规则；保存不会自动启动转发。",
        )
    } else {
        ("Local program requests a forwarding change", "Confirm", "Cancel", "A program on this computer requested this operation through the Tunnelde local API. Review the complete rule. Saving does not start forwarding.")
    };
    let action = match mutation {
        Mutation::Save { revision: None, .. } => {
            if chinese {
                "新建规则"
            } else {
                "Create rule"
            }
        }
        Mutation::Save { .. } => {
            if chinese {
                "保存规则"
            } else {
                "Save rule"
            }
        }
        Mutation::Remove { .. } => {
            if chinese {
                "删除规则"
            } else {
                "Remove rule"
            }
        }
        Mutation::Stop { .. } => {
            if chinese {
                "停止转发"
            } else {
                "Stop forwarding"
            }
        }
    };
    let rule = match mutation {
        Mutation::Save { rule, .. } => rule,
        _ => &current.expect("reviewed existing rule").info.rule,
    };
    let host_name = match crate::services::hosts::resolve(app, &rule.host_id) {
        Ok(host) => host.name,
        // Orphaned rules can still be explicitly stopped or removed. Saving
        // always requires a current saved host, rechecked by the transaction.
        Err(error) if matches!(mutation, Mutation::Save { .. }) => return Err(map_error(error)),
        Err(_) => if chinese {
            "主机已不可用"
        } else {
            "Host unavailable"
        }
        .into(),
    };
    let clean = |text: &str| {
        text.chars()
            .filter(|c| {
                !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
            .take(253)
            .collect::<String>()
    };
    let previous_label = if chinese {
        "原规则"
    } else {
        "Previous rule"
    };
    let host_label = if chinese { "主机" } else { "Host" };
    let previous = current
        .filter(|_| matches!(mutation, Mutation::Save { .. }))
        .map(|c| {
            format!(
                "\n{previous_label}: {} [{}] · {}\n{}:{} → {}:{}",
                clean(&c.info.rule.name),
                clean(&c.info.rule.host_id),
                c.info.rule.mode,
                clean(&c.info.rule.bind_host),
                c.info.rule.bind_port,
                clean(&c.info.rule.target_host),
                c.info.rule.target_port
            )
        })
        .unwrap_or_default();
    let exposure =
        if ["localhost", "127.0.0.1", "::1"].contains(&rule.bind_host.to_lowercase().as_str()) {
            ""
        } else if chinese {
            "\n注意：监听地址可能允许其他设备访问。"
        } else {
            "\nWarning: this bind address may allow access from other devices."
        };
    let message = format!("{explanation}\n\n{action}\n{} ({})\n{host_label}: {} [{}]\n{} · {}:{} → {}:{}{previous}{exposure}",clean(&rule.name),rule.id,clean(&host_name),rule.host_id,rule.mode,clean(&rule.bind_host),rule.bind_port,clean(&rule.target_host),rule.target_port);
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |answer| {
            let _ = sender.send(answer);
            drop(permit);
        });
    response(receiver, CONFIRMATION_TIMEOUT).await
}
pub(super) async fn response(
    receiver: oneshot::Receiver<bool>,
    budget: Duration,
) -> Result<bool, Failure> {
    let deadline = tokio::time::Instant::now() + budget;
    let expired = || {
        Failure::new(
            "operation_rejected",
            "Forwarding confirmation expired; no change was submitted",
        )
    };
    let confirmed = tokio::time::timeout_at(deadline, receiver)
        .await
        .map_err(|_| expired())?
        .map_err(|_| {
            Failure::new(
                "operation_rejected",
                "Forwarding confirmation closed; no change was submitted",
            )
        })?;
    if tokio::time::Instant::now() >= deadline {
        return Err(expired());
    }
    Ok(confirmed)
}
