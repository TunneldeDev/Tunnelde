# macOS background window and Dock lifecycle

## Changes

- Handle the native macOS `RunEvent::Reopen` by restoring, unminimizing and focusing the retained main window. Restore the application itself as well, covering Hide / Cmd+H.
- Restore Regular activation policy before reopening through the Dock, tray or single-instance relaunch.
- Add `showDockIconInBackground`, defaulting to true. Only macOS exposes this General preference. A successful close hides the window, then chooses Regular or Accessory policy from the latest settings and actual visibility on the main thread. Visible or minimized windows keep normal Dock behavior.
- Re-evaluate the policy after settings updates and resets, including profile switches and imports. The preference is portable in both frontend and native allowlists; legacy settings and profiles retain the default.
- Use Tauri activation policy rather than its Dock transformation API: the latter intentionally ignores hides shortly after showing, which would make rapid close/reopen interactions unreliable.
- Existing close guards continue to retain sessions and unsaved drafts while hiding the macOS window. Quit remains the explicit way to terminate the application.

## Verification

- Settings UI regression checks cover macOS-only visibility, enabled default, toggling and resetting, with Windows and Linux coverage.
- Native database tests cover upgrading existing preferences and persisting both choices. Profile tests cover legacy defaults and false-valued exports.
- The existing native-close frontend tests cover retained drafts and the shared macOS close policy.
- Windows host validation: frontend checks, Rust tests, Clippy, formatting and production build. macOS release builds compile both Apple Silicon and Intel code paths.

Actual Dock/AppKit interaction cannot be run on the Windows development host. The remaining macOS runtime checklist is: close and reopen through Dock; minimize and reopen; Cmd+H and reopen; disable the preference, close and restore using the tray and application launch; repeat close/reopen rapidly; confirm sessions/drafts persist; confirm Quit terminates the process.
