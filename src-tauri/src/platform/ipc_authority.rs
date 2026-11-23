//! Application commands are coordinator-only unless a dedicated, registered
//! view gateway explicitly handles them. Window ACLs for core Tauri plugins are
//! separate; giving a satellite native window controls must not implicitly give
//! it every host/SSH/credential/application command in generate_handler!.

use tauri::Manager;

fn allowed(label: &str, command: &str, registered: bool) -> bool {
    label == "main"
        || (registered
            && matches!(
                command,
                "panel_window_initialize"
                    | "panel_window_control"
                    | "panel_window_show"
                    | "panel_window_create"
                    | "panel_window_destroy"
                    | "panel_window_drop_target"
                    | "panel_window_release_drag"
                    | "panel_window_disconnect"
                    | "panel_window_forwarding"
                    | "panel_window_files"
                    | "panel_window_terminal"
                    | "panel_window_terminal_attach"
                    | "panel_window_focus"
                    | "panel_window_plugin_view"
                    | "diagnostics_report"
            ))
}

pub(crate) fn guard(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        let webview = invoke.message.webview_ref();
        let command = invoke.message.command();
        if !allowed(
            webview.label(),
            command,
            super::panel_windows::native::registered(webview.app_handle(), webview.label()),
        ) {
            invoke
                .resolver
                .reject(crate::error::AppError::validation("invalid window"));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_control_permissions_cannot_be_used_to_escalate_application_authority() {
        for command in [
            "hosts_snapshot",
            "host_create",
            "ssh_connect",
            "ssh_disconnect",
            "forwarding_save",
            "forwarding_stop",
            "forwarding_group_save",
            "forwarding_group_remove",
            "forwarding_start_managed",
            "clipboard_read_text",
            "plugin_frontend_open",
            "plugin_frontend_view_open",
            "plugin_frontend_ready",
            "plugin_frontend_failed",
            "plugin_frontend_call",
            "settings_update",
            "main_window_suspend",
            "logs_write",
            "logs_output_read",
        ] {
            assert!(allowed("main", command, false));
            assert!(!allowed("panel-one", command, true));
            assert!(!allowed("panel-one", command, false));
        }
        for command in [
            "panel_window_initialize",
            "panel_window_control",
            "panel_window_show",
            "panel_window_create",
            "panel_window_destroy",
            "panel_window_drop_target",
            "panel_window_release_drag",
            "panel_window_disconnect",
            "panel_window_forwarding",
            "panel_window_files",
            "panel_window_terminal",
            "panel_window_terminal_attach",
            "panel_window_focus",
            "panel_window_plugin_view",
            "diagnostics_report",
        ] {
            assert!(allowed("panel-one", command, true));
            assert!(!allowed("panel-one", command, false));
        }
        for label in [
            "",
            "Main",
            "main/subview",
            "main-window",
            "panel-one",
            "plugin-main",
            "main\0",
        ] {
            assert!(!allowed(label, "ssh_connect", true));
        }
    }
}
