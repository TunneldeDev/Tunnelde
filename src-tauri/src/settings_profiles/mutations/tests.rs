use super::planning::Change;
use super::{
    contracts::*,
    drafts::{Owner, Registry},
    *,
};
use crate::{
    db::Database,
    services::settings::preferences,
    settings::{Settings, UiProviderSelection},
    settings_profiles::{content, portable, repository, SettingsProfile},
};
use serde_json::json;
use std::sync::Arc;

fn owner() -> Owner {
    Owner {
        id: "tools".into(),
        fingerprint: "digest".into(),
        generation: 1,
    }
}
fn values() -> serde_json::Value {
    preferences::profile_values(&Settings::default()).unwrap()
}
fn revision(db: &Database) -> String {
    content::catalogue(db, || Ok(())).unwrap().revision
}
fn upload(registry: &Registry, revision: &str, text: &str) -> String {
    let draft = registry
        .prepare(owner(), revision.into(), text.len())
        .unwrap();
    let mut offset = 0;
    while offset < text.len() {
        let mut end = (offset + drafts::MAX_APPEND_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        registry
            .append(
                &owner(),
                Append {
                    draft_id: draft.draft_id.clone(),
                    offset,
                    text: text[offset..end].into(),
                },
            )
            .unwrap();
        offset = end;
    }
    draft.draft_id
}
fn save_values(
    db: &Database,
    revision: &str,
    id: Option<String>,
    name: &str,
    values: &serde_json::Value,
) -> Change {
    let registry = Arc::new(Registry::default());
    let draft_id = upload(&registry, revision, &values.to_string());
    let claim = registry.claim(&owner(), &draft_id).unwrap();
    save(
        db,
        &claim,
        Save {
            revision: revision.into(),
            draft_id,
            id,
            name: name.into(),
        },
        || Ok(()),
    )
    .unwrap()
}

#[test]
fn public_crud_round_trips_without_changing_current_preferences() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| crate::db::settings::save(conn, &Settings::default()))
        .unwrap();
    let create = save_values(&db, &revision(&db), None, " 工作 ", &values());
    db.with(|conn| create.persist(conn, || Ok(()))).unwrap();
    let first = create.result();
    assert_eq!(first.revision, revision(&db));
    db.with(|conn| {
        let saved = repository::read(conn)?;
        assert_eq!(saved.profiles[0].name, "工作");
        assert!(saved.active_id.is_none());
        repository::select(conn, Some(&first.id))
    })
    .unwrap();
    let rename = rename(
        &db,
        Rename {
            id: first.id.clone(),
            revision: first.revision,
            name: "Personal".into(),
        },
        || Ok(()),
    )
    .unwrap();
    db.with(|conn| rename.persist(conn, || Ok(()))).unwrap();
    let after = content::catalogue(&db, || Ok(())).unwrap();
    assert_eq!(after.items[0].name, "Personal");
    assert_eq!(after.active_id.as_deref(), Some(first.id.as_str()));
    let mut next = values();
    next["appearance"]["theme"] = "light".into();
    let replace = save_values(
        &db,
        &after.revision,
        Some(first.id.clone()),
        "Personal",
        &next,
    );
    db.with(|conn| replace.persist(conn, || Ok(()))).unwrap();
    let remove = delete(
        &db,
        Delete {
            id: first.id,
            revision: replace.result().revision,
        },
        || Ok(()),
    )
    .unwrap();
    db.with(|conn| remove.persist(conn, || Ok(()))).unwrap();
    db.with(|conn| {
        assert!(repository::read(conn)?.active_id.is_none());
        assert!(repository::read(conn)?.profiles.is_empty());
        assert_eq!(crate::db::settings::load(conn)?.theme, "system");
        Ok(())
    })
    .unwrap();
}

#[test]
fn replacement_preserves_saved_private_fields_and_activation_preserves_current_ones() {
    let db = Database::in_memory().unwrap();
    let mut previous = Settings::default();
    previous.ui_providers.insert(
        "preferences".into(),
        UiProviderSelection {
            plugin_id: "saved-private".into(),
            view_id: "view".into(),
        },
    );
    db.with(|conn| {
        repository::save(
            conn,
            &[SettingsProfile {
                id: "work".into(),
                name: "Work".into(),
                updated_at: 1,
                settings: portable(&previous)?,
            }],
        )
    })
    .unwrap();
    let change = save_values(&db, &revision(&db), Some("work".into()), "Work", &values());
    db.with(|conn| change.persist(conn, || Ok(()))).unwrap();
    db.with(|conn| {
        assert_eq!(
            repository::read(conn)?.profiles[0].settings["uiProviders"]["preferences"]["pluginId"],
            "saved-private"
        );
        Ok(())
    })
    .unwrap();
    let review = activation(
        &db,
        &Activate {
            id: "work".into(),
            revision: revision(&db),
            preferences_revision: "unused-by-plan".into(),
        },
        || Ok(()),
    )
    .unwrap();
    let mut current = Settings {
        last_update_check: Some(123),
        ..Settings::default()
    };
    current.ui_providers.insert(
        "preferences".into(),
        UiProviderSelection {
            plugin_id: "current-private".into(),
            view_id: "current-view".into(),
        },
    );
    let next = preferences::apply_profile_values(&current, review.values.clone()).unwrap();
    assert_eq!(
        next.ui_providers["preferences"].plugin_id,
        "current-private"
    );
    assert_eq!(next.last_update_check, Some(123));
    db.with(|conn| {
        repository::save(conn, &[])?;
        assert!(review.compare(conn).is_err());
        Ok(())
    })
    .unwrap();
}

#[test]
fn invalid_full_values_names_missing_targets_and_stale_drafts_do_not_write() {
    let db = Database::in_memory().unwrap();
    let registry = Arc::new(Registry::default());
    let initial = revision(&db);
    for body in [
        json!({}),
        json!({"appearance":{"theme":"light"}}),
        {
            let mut body = values();
            body["uiProviders"] = json!({});
            body
        },
        {
            let mut body = values();
            body["appearance"]["userCss"] = "@import 'https://example.invalid/a.css';".into();
            body
        },
    ] {
        let draft_id = upload(&registry, &initial, &body.to_string());
        let claim = registry.claim(&owner(), &draft_id).unwrap();
        assert!(save(
            &db,
            &claim,
            Save {
                revision: initial.clone(),
                draft_id,
                name: "Work".into(),
                id: None
            },
            || Ok(())
        )
        .is_err());
        drop(claim);
        assert_eq!(initial, revision(&db));
    }
    let first = save_values(&db, &initial, None, "Work", &values());
    db.with(|conn| first.persist(conn, || Ok(()))).unwrap();
    let current = revision(&db);
    for request in [
        Rename {
            id: first.result().id.clone(),
            revision: current.clone(),
            name: "\n".into(),
        },
        Rename {
            id: "missing".into(),
            revision: current.clone(),
            name: "Other".into(),
        },
    ] {
        assert!(rename(&db, request, || Ok(())).is_err());
    }
    let draft_id = upload(&registry, &initial, &values().to_string());
    let claim = registry.claim(&owner(), &draft_id).unwrap();
    assert!(save(
        &db,
        &claim,
        Save {
            revision: current.clone(),
            draft_id: draft_id.clone(),
            name: "Other".into(),
            id: None
        },
        || Ok(())
    )
    .is_err());
    assert!(save(
        &db,
        &claim,
        Save {
            revision: initial,
            draft_id,
            name: "Other".into(),
            id: None
        },
        || Ok(())
    )
    .is_err());
    assert_eq!(current, revision(&db));
    for request in [
        json!({"revision":current,"draftId":"a","name":"Work","id":null}),
        json!({"revision":current,"draftId":"a","name":"Work","extra":1}),
    ] {
        assert!(serde_json::from_value::<Save>(request).is_err());
    }
}

#[test]
fn duplicate_names_and_limits_are_enforced_without_overwriting_other_profiles() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        repository::save(
            conn,
            &[
                SettingsProfile {
                    id: "one".into(),
                    name: "One".into(),
                    updated_at: 1,
                    settings: portable(&Settings::default())?,
                },
                SettingsProfile {
                    id: "two".into(),
                    name: "Two".into(),
                    updated_at: 1,
                    settings: portable(&Settings::default())?,
                },
            ],
        )
    })
    .unwrap();
    assert_eq!(
        rename(
            &db,
            Rename {
                id: "two".into(),
                name: " ONE ".into(),
                revision: revision(&db)
            },
            || Ok(())
        )
        .err()
        .unwrap()
        .to_string(),
        "profiles.duplicateName"
    );
    db.with(|conn| {
        let profiles = (0..32)
            .map(|i| SettingsProfile {
                id: format!("id{i}"),
                name: format!("Name{i}"),
                updated_at: 1,
                settings: portable(&Settings::default()).unwrap(),
            })
            .collect::<Vec<_>>();
        repository::save(conn, &profiles)
    })
    .unwrap();
    let registry = Arc::new(Registry::default());
    let revision = revision(&db);
    let draft_id = upload(&registry, &revision, &values().to_string());
    let claim = registry.claim(&owner(), &draft_id).unwrap();
    assert_eq!(
        save(
            &db,
            &claim,
            Save {
                revision,
                draft_id,
                id: None,
                name: "New".into()
            },
            || Ok(())
        )
        .err()
        .unwrap()
        .to_string(),
        "profiles.limit"
    );
}

#[test]
fn emit_actual_public_profile_mutations_for_sdk() {
    let db = Database::in_memory().unwrap();
    let registry = Arc::new(Registry::default());
    let revision = revision(&db);
    let native = Settings {
        user_css: format!("{}/*中文😀*/", "\u{0001}".repeat(190_000)),
        theme: "light".into(),
        ..Settings::default()
    };
    let values = preferences::profile_values(&native).unwrap();
    let text = serde_json::to_string(&values).unwrap();
    assert!(text.len() > 1024 * 1024);
    let prepared = registry
        .prepare(owner(), revision.clone(), text.len())
        .unwrap();
    let draft_id = prepared.draft_id.clone();
    let mut upload = vec![
        json!({"method":"profiles.drafts.prepare","request":{"revision":revision,"totalBytes":text.len()},"result":prepared}),
    ];
    let mut offset = 0;
    while offset < text.len() {
        let mut end = (offset + drafts::MAX_APPEND_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let params = json!({"draftId":draft_id,"offset":offset,"text":text[offset..end]});
        let response = registry
            .append(&owner(), serde_json::from_value(params.clone()).unwrap())
            .unwrap();
        upload.push(json!({"method":"profiles.drafts.append","request":params,"result":response}));
        offset = end;
    }
    let claim = registry.claim(&owner(), &draft_id).unwrap();
    let save_request = json!({"draftId":draft_id,"revision":revision,"name":"SDK Work 中文😀"});
    let change = save(
        &db,
        &claim,
        serde_json::from_value(save_request.clone()).unwrap(),
        || Ok(()),
    )
    .unwrap();
    db.with(|conn| change.persist(conn, || Ok(()))).unwrap();
    let save_result = change.result();
    let rename_request =
        json!({"id":save_result.id,"revision":save_result.revision,"name":"SDK Renamed"});
    let change = rename(
        &db,
        serde_json::from_value(rename_request.clone()).unwrap(),
        || Ok(()),
    )
    .unwrap();
    db.with(|conn| change.persist(conn, || Ok(()))).unwrap();
    let rename_result = change.result();
    let delete_request = json!({"id":rename_result.id,"revision":rename_result.revision});
    let change = delete(
        &db,
        serde_json::from_value(delete_request.clone()).unwrap(),
        || Ok(()),
    )
    .unwrap();
    db.with(|conn| change.persist(conn, || Ok(()))).unwrap();
    let delete_result = change.result();
    if let Some(path) = std::env::var_os("TUNNELDE_PROFILE_MUTATION_OUTPUT") {
        std::fs::write(path,serde_json::to_vec(&json!({"revision":revision,"values":values,"upload":upload,"saveRequest":save_request,"saveResult":save_result,"renameRequest":rename_request,"renameResult":rename_result,"deleteRequest":delete_request,"deleteResult":delete_result})).unwrap()).unwrap();
    }
}
