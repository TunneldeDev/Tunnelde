//! CORS is tied to the trusted host configuration, never to the requesting
//! page's Origin header. A custom development port must not break plugin imports
//! or preview resources; packaged application origins remain unchanged.

pub(crate) fn for_app(app: &tauri::AppHandle) -> String {
    resolve(
        cfg!(dev),
        app.config()
            .build
            .dev_url
            .as_ref()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(|url| url.origin().ascii_serialization()),
        cfg!(target_os = "windows"),
    )
}

fn resolve(dev: bool, configured: Option<String>, windows: bool) -> String {
    if dev {
        configured.unwrap_or_else(|| "http://localhost:1420".into())
    } else if windows {
        "http://tauri.localhost".into()
    } else {
        "tauri://localhost".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_development_origin_does_not_change_packaged_origins() {
        assert_eq!(
            resolve(true, Some("http://127.0.0.1:1449".into()), false),
            "http://127.0.0.1:1449"
        );
        assert_eq!(
            resolve(true, Some("https://localhost:1449".into()), true),
            "https://localhost:1449"
        );
        assert_eq!(resolve(true, None, false), "http://localhost:1420");
        assert_eq!(
            resolve(false, Some("https://unrelated.invalid".into()), true),
            "http://tauri.localhost"
        );
        assert_eq!(
            resolve(false, Some("https://unrelated.invalid".into()), false),
            "tauri://localhost"
        );
    }
}
