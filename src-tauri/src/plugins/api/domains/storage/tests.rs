use super::*;
use crate::plugins::api::optional;
use serde_json::json;

#[test]
fn validates_parameter_types_and_storage_names() {
    assert!(field::<String>(&json!({"id":42}), "id").is_err());
    assert!(field::<String>(&json!({}), "id").is_err());
    assert!(optional::<bool>(&json!({"overwrite":"yes"}), "overwrite").is_err());
    for key in ["", "../other", "a/b", "__proto__", "constructor", "键"] {
        assert!(storage_key(&json!({"key":key})).is_err());
    }
    assert_eq!(
        storage_key(&json!({"key":"draft.v1-2_3"})).unwrap(),
        "draft.v1-2_3"
    );
}

#[test]
fn scopes_storage_by_plugin_identity_without_path_interpolation() {
    let root = Path::new("store");
    let a = storage_path(root, "plugin-a");
    assert_ne!(a, storage_path(root, "plugin-b"));
    assert_eq!(a, storage_path(root, "plugin-a"));
    assert_eq!(storage_path(root, "../../secret").parent(), Some(root));
}

#[tokio::test]
async fn plugin_storage_persists_isolates_and_removes_values() {
    let root = std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
    let key = json!({"key": "draft"});
    let value = json!({"key": "draft", "value": {"number": 42, "enabled": true}});
    assert_eq!(
        storage_at(&root, "a", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        storage_at(&root, "a", "storage.set", &value, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        storage_at(&root, "a", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        value["value"]
    );
    assert_eq!(
        storage_at(&root, "b", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        storage_at(&root, "a", "storage.delete", &key, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        storage_at(&root, "a", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn plugin_storage_rechecks_authorization_before_commit_and_cleans_staging() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
    let key = json!({"key": "draft"});
    let original = json!({"key": "draft", "value": "original"});
    storage_at(&root, "a", "storage.set", &original, || Ok(()))
        .await
        .unwrap();
    let checks = AtomicUsize::new(0);
    let changed = json!({"key": "draft", "value": "changed"});
    let result = storage_at(&root, "a", "storage.set", &changed, || {
        if checks.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err(AppError::validation("test.revoked"))
        }
    })
    .await;
    assert!(result.is_err());
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    assert_eq!(
        storage_at(&root, "a", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        "original"
    );
    let mut entries = tokio::fs::read_dir(&root).await.unwrap();
    assert!(entries.next_entry().await.unwrap().is_some());
    assert!(entries.next_entry().await.unwrap().is_none());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn plugin_storage_rejects_oversized_writes_without_losing_existing_data() {
    let root = std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
    let key = json!({"key": "draft"});
    storage_at(
        &root,
        "a",
        "storage.set",
        &json!({"key":"draft","value":"original"}),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(storage_at(
        &root,
        "a",
        "storage.set",
        &json!({"key":"draft","value":"x".repeat(MAX_STORAGE)}),
        || Ok(())
    )
    .await
    .is_err());
    assert_eq!(
        storage_at(&root, "a", "storage.get", &key, || Ok(()))
            .await
            .unwrap(),
        "original"
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn plugin_storage_serializes_concurrent_updates() {
    let root = std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
    let first = json!({"key": "first", "value": 1});
    let second = json!({"key": "second", "value": 2});
    let (a, b) = tokio::join!(
        storage_at(&root, "a", "storage.set", &first, || Ok(())),
        storage_at(&root, "a", "storage.set", &second, || Ok(())),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        storage_at(
            &root,
            "a",
            "storage.get",
            &json!({"key":"first"}),
            || Ok(())
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        storage_at(&root, "a", "storage.get", &json!({"key":"second"}), || Ok(
            ()
        ))
        .await
        .unwrap(),
        2
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}
