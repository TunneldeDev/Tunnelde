use super::*;
use crate::settings::Settings;
use serde_json::{json, Value};

#[test]
fn independent_schema_covers_exactly_the_public_projection() {
    let mut defaults = Settings::default();
    defaults.sanitize();
    let values = projection::values(&defaults).unwrap();
    let internal = serde_json::to_value(&defaults).unwrap();
    let mut mapped = std::collections::HashSet::new();
    for group in mapping::GROUPS {
        schema::check(&schema::groups()[group.id], &values[group.id], group.id).unwrap();
        assert_eq!(
            group.fields.len(),
            schema::groups()[group.id]["properties"]
                .as_object()
                .unwrap()
                .len()
        );
        for &(public, private) in group.fields {
            assert!(mapped.insert(private));
            assert!(!values[group.id][public].is_null() || public == "sort");
        }
    }
    let excluded = ["uiProviders", "lastUpdateCheck", "skippedVersion"];
    let covered: std::collections::HashSet<_> = mapped
        .iter()
        .map(|path| path.split('.').next().unwrap())
        .collect();
    for key in internal.as_object().unwrap().keys() {
        assert!(
            excluded.contains(&key.as_str()) || covered.contains(key.as_str()),
            "unclassified setting: {key}"
        );
    }
    for key in excluded {
        assert!(!covered.contains(key));
    }
    assert_eq!(65, mapped.len());
}

#[test]
fn only_supplied_fields_change_and_collections_replace() {
    let mut previous = Settings::default();
    previous.network.profiles = Vec::new();
    previous.colors.insert("editor".into(), "#abcdef".into());
    previous.host_list.widths.insert("name".into(), 300);
    let host_list = json!({"view":"tree", "order":["name"], "hidden":[], "widths":{}, "sort":null});
    let next = update::apply(
        &previous,
        json!({
            "appearance":{"theme":"dark","colors":{}},
            "workspace":{"hostList":host_list},
            "network":{"features":{}}
        }),
    )
    .unwrap();
    assert_eq!(next.theme, "dark");
    assert!(next.colors.is_empty());
    assert!(next.host_list.widths.is_empty());
    assert_eq!(next.editor_tab_size, previous.editor_tab_size);
    assert_eq!(next.last_update_check, previous.last_update_check);
    assert_eq!(next.network.default_proxy, previous.network.default_proxy);
}

#[test]
fn invalid_values_unknown_fields_and_silent_normalization_are_rejected() {
    for changes in [
        json!({"uiProviders":{}}),
        json!({"appearance":{"unknown":true}}),
        json!({"terminal":{"scrollback":0}}),
        json!({"appearance":{"fontSize":12.5}}),
        json!({"appearance":{"theme":"night"}}),
        json!({"general":{"language":true}}),
        json!({"appearance":{"accent":"invalid"}}),
        json!({"appearance":{"colors":{"editor":"nope"}}}),
        json!({"shortcuts":{"bindings":{"arbitrary":["Invalid+key"]}}}),
        json!({"terminal":{"lineHeight":1.25}}),
        json!({"network":{"defaultProxy":"missing"}}),
        json!({"network":{"profiles":[{"id":"a","name":"a","host":"localhost","port":80,"protocol":"http","username":"","password":"secret"}]}}),
    ] {
        let error = update::apply(&Settings::default(), changes.clone()).unwrap_err();
        assert!(
            error.to_string().starts_with("preferences.invalidValue:"),
            "{changes}: {error}"
        );
        assert!(!error.to_string().contains("secret"));
    }
}

#[test]
fn schema_handles_unicode_size_numeric_bounds_and_required_nested_fields() {
    let string = json!({"type":"string","maxLength":2,"x-maxBytes":5});
    assert!(schema::check(&string, &json!("😀a"), "test").is_ok());
    assert!(schema::check(&string, &json!("😀😀"), "test").is_err());
    assert!(schema::check(
        &json!({"type":"number","multipleOf":0.1}),
        &json!(1.2),
        "test"
    )
    .is_ok());
    assert!(schema::check(&json!({"type":"integer","minimum":1}), &json!(-1), "test").is_err());
    assert!(schema::check(
        &json!({"type":"string","pattern":"ignored?"}),
        &json!("a"),
        "test"
    )
    .is_err());
    assert!(update::apply(
        &Settings::default(),
        json!({"workspace":{"hostList":{"view":"tree"}}})
    )
    .is_err());
    let too_long = Value::String("中".repeat(70_000));
    assert!(update::apply(
        &Settings::default(),
        json!({"appearance":{"userCss":too_long}})
    )
    .is_err());
}

#[test]
fn update_envelope_rejects_extra_keys_and_requires_revision() {
    assert!(serde_json::from_value::<contracts::Update>(json!({"changes":{}})).is_err());
    assert!(serde_json::from_value::<contracts::Update>(
        json!({"revision":"x","changes":{},"extra":true})
    )
    .is_err());
}
