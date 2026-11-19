//! Application commands are coordinator-only unless a dedicated, registered
//! view gateway explicitly handles them. Window ACLs for core Tauri plugins are
//! separate; giving a satellite native window controls must not implicitly give
//! it every host/SSH/credential/application command in generate_handler!.

fn coordinator(label: &str) -> bool {
    label == "main"
}

pub(crate) fn guard<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !coordinator(invoke.message.webview_ref().label()) {
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
    fn similar_unregistered_and_future_panel_labels_have_no_application_authority() {
        assert!(coordinator("main"));
        for label in [
            "",
            "Main",
            "main/subview",
            "main-window",
            "panel-one",
            "panel-main",
            "plugin-main",
            "main\0",
        ] {
            assert!(!coordinator(label));
        }
    }
}
