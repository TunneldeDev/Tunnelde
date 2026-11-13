//! Plain native consent precedes all SSH probing/authentication. A late native
//! callback sends a boolean only; it has no authority to mutate the request.
use super::*;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(253)
        .collect()
}
pub(super) async fn run(
    app: AppHandle,
    id: String,
    captured: Captured,
    permit: OwnedSemaphorePermit,
) {
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let rule = &captured.entry.rule;
    let direction = match (chinese, rule.mode.as_str()) {
        (true, "local") => "本机监听 → 远端目标",
        (true, _) => "远端监听 → 本机目标",
        (false, "local") => "Local listener → remote target",
        _ => "Remote listener → local target",
    };
    let heading = if chinese {
        "本机程序请求启动以下转发。请核对目标，确认后在 Tunnelde 输入凭据。"
    } else {
        "A local program requests this forwarding rule. Review the destination; enter credentials only in Tunnelde after confirming."
    };
    let exposure =
        if ["localhost", "127.0.0.1", "::1"].contains(&rule.bind_host.to_lowercase().as_str()) {
            ""
        } else if chinese {
            "\n注意：该监听地址可能允许其他设备访问。"
        } else {
            "\nWarning: this listener may be accessible from other devices."
        };
    let hops = captured
        .jumps
        .iter()
        .map(|h| format!("{}@{}:{} → ", clean(&h.username), clean(&h.host), h.port))
        .collect::<String>();
    let message = format!(
        "{heading}\n\n{}\n{} [{}]\n{hops}{}@{}:{}\n{direction}\n{}:{} → {}:{}{exposure}",
        clean(&rule.name),
        clean(&captured.host.name),
        clean(&captured.host.id),
        clean(&captured.host.username),
        clean(&captured.host.host),
        captured.host.port,
        clean(&rule.bind_host),
        rule.bind_port,
        clean(&rule.target_host),
        rule.target_port
    );
    let (sender, receiver) = oneshot::channel();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    crate::platform::window::show_main(&app);
    app.dialog()
        .message(message)
        .title(if chinese {
            "外部程序请求启动转发"
        } else {
            "Local forwarding start request"
        })
        .buttons(MessageDialogButtons::OkCancelCustom(
            if chinese { "继续" } else { "Continue" }.into(),
            if chinese { "取消" } else { "Cancel" }.into(),
        ))
        .show(move |answer| {
            let _ = sender.send(answer);
            drop(permit);
        });
    let result = tokio::time::timeout_at(deadline, receiver).await;
    let state = app.state::<AppState>();
    if let Ok(mut manager) = state.forward_starts.lock() {
        if let Ok(entry) = manager.book.get(&id, Instant::now()) {
            if entry.check(Instant::now()).is_ok() {
                match result {
                    Ok(Ok(true)) if tokio::time::Instant::now() < deadline => {
                        let reviewed = verify_rule(&app, &captured)
                            .and_then(|_| Target::capture(&app, &captured.review));
                        match reviewed {
                            Ok(_) => entry.receipt.phase = Phase::Credentials,
                            Err(_) => entry.finish(
                                Phase::Failed,
                                Some("ssh.connectionChanged"),
                                Instant::now(),
                            ),
                        }
                    }
                    Ok(Ok(false)) => entry.finish(Phase::Dismissed, None, Instant::now()),
                    _ => entry.finish(Phase::Expired, Some("forward.startExpired"), Instant::now()),
                }
            }
        }
    }
    changed(&app);
}
