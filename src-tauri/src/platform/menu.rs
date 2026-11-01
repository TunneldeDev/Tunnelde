use tauri::AppHandle;

use crate::error::AppResult;

/// Windows and Linux use only the window title bar. macOS keeps its standard
/// system menu for editing shortcuts, application lifecycle and window actions.
pub fn apply(app: &AppHandle, _locale: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    app.set_menu(tauri::menu::Menu::default(app)?)?;
    #[cfg(not(target_os = "macos"))]
    app.remove_menu()?;
    Ok(())
}
