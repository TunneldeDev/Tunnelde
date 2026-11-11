use super::*;
use serde_json::json;

#[test]
fn legacy_maps_replace_and_other_fields_merge_without_losing_preferences() {
    let initial = apply(
        &Settings::default(),
        json!({
            "theme":"light",
            "colors":{"background":"#123456"},
            "keyboardShortcuts":{"app.settings":["F2"]},
            "shortcutRules":{"app.settings":{"F2":{"priority":7}}},
            "uiProviders":{"quickAccess":{"pluginId":"test","viewId":"search"}},
            "hostList":{"widths":{"name":220},"view":"table"}
        }),
    )
    .unwrap();
    let next = apply(
        &initial,
        json!({"colors":{},"keyboardShortcuts":{},"shortcutRules":{},"uiProviders":{},"hostList":{"view":"list"}}),
    )
    .unwrap();
    assert!(next.colors.is_empty());
    assert!(next.keyboard_shortcuts.is_empty());
    assert!(next.shortcut_rules.is_empty());
    assert!(next.ui_providers.is_empty());
    assert_eq!(next.theme, "light");
    assert_eq!(
        serde_json::to_value(&next).unwrap()["hostList"]["widths"]["name"],
        220
    );
}

#[test]
fn rejected_patches_do_not_change_the_previous_settings() {
    let previous = Settings::default();
    let serialized = serde_json::to_value(&previous).unwrap();
    for patch in [Value::Null, json!([]), json!({"closeToTray":"no"})] {
        assert!(apply(&previous, patch).is_err());
        assert_eq!(serde_json::to_value(&previous).unwrap(), serialized);
    }
}

#[test]
fn preference_patch_preserves_committed_update_metadata() {
    let previous = Settings {
        last_update_check: Some(42),
        skipped_version: Some("1.2.3".into()),
        ..Settings::default()
    };
    let next = apply(&previous, json!({"theme":"light"})).unwrap();
    assert_eq!(next.last_update_check, Some(42));
    assert_eq!(next.skipped_version.as_deref(), Some("1.2.3"));
}
