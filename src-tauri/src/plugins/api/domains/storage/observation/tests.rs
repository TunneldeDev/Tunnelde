use super::*;
use crate::plugins::api::domains::storage::{storage_at, storage_path};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "tunnelde-storage-observation-{}",
        uuid::Uuid::new_v4()
    ))
}
async fn observe_at(root: &std::path::Path, id: &str, revision: Option<&str>) -> Value {
    let request = revision.map_or_else(|| json!({}), |revision| json!({"revision": revision}));
    storage_at(root, id, "storage.observe", &request, || Ok(()))
        .await
        .unwrap()
}

#[tokio::test]
async fn empty_observation_does_not_create_storage_and_rejects_invalid_requests() {
    let root = root();
    for request in [
        Value::Null,
        json!([]),
        json!({"revision":null}),
        json!({"revision":true}),
        json!({"revision":""}),
        json!({"revision":"x".repeat(129)}),
        json!({"revision":"😀".repeat(33)}),
        json!({"revision":"x\n"}),
        json!({"revision":"\u{0085}"}),
        json!({"id":"other"}),
        json!({"path":"/"}),
    ] {
        let called = AtomicUsize::new(0);
        assert!(storage_at(&root, "one", "storage.observe", &request, || {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .is_err());
        assert_eq!(called.load(Ordering::SeqCst), 0);
    }
    let first = observe_at(&root, "one", None).await;
    assert_eq!(first["snapshot"]["values"], json!({}));
    let revision = first["revision"].as_str().unwrap();
    assert_eq!(
        observe_at(&root, "one", Some(revision)).await,
        json!({"version":1,"revision":revision,"changed":false})
    );
    assert!(!root.exists());
}

#[tokio::test]
async fn existing_storage_mutations_deletes_null_and_plugin_isolation_share_the_contract() {
    let root = root();
    storage_at(
        &root,
        "one",
        "storage.set",
        &json!({"key":"draft","value":{"text":"你好","enabled":true}}),
        || Ok(()),
    )
    .await
    .unwrap();
    let first = observe_at(&root, "one", None).await;
    assert_eq!(
        first["snapshot"]["values"]["draft"],
        json!({"text":"你好","enabled":true})
    );
    let other = observe_at(&root, "two", None).await;
    assert_eq!(other["snapshot"]["values"], json!({}));
    assert_ne!(first["revision"], other["revision"]);
    storage_at(
        &root,
        "one",
        "storage.set",
        &json!({"key":"draft","value":null}),
        || Ok(()),
    )
    .await
    .unwrap();
    let present = observe_at(&root, "one", first["revision"].as_str()).await;
    assert_eq!(present["changed"], true);
    assert_eq!(present["snapshot"]["values"], json!({"draft":null}));
    storage_at(
        &root,
        "one",
        "storage.delete",
        &json!({"key":"draft"}),
        || Ok(()),
    )
    .await
    .unwrap();
    let deleted = observe_at(&root, "one", present["revision"].as_str()).await;
    assert_eq!(deleted["snapshot"]["values"], json!({}));
    assert_ne!(deleted["revision"], present["revision"]);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn legacy_file_reads_are_unchanged_and_object_order_does_not_change_revision() {
    let root = root();
    tokio::fs::create_dir(&root).await.unwrap();
    let path = storage_path(&root, "one");
    let initial = r#"{ "draft": {"z":2,"a":1}, "flag": false }"#;
    tokio::fs::write(&path, initial).await.unwrap();
    let first = observe_at(&root, "one", None).await;
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), initial);
    tokio::fs::write(&path, r#"{"flag":false,"draft":{"a":1,"z":2}}"#)
        .await
        .unwrap();
    let idle = observe_at(&root, "one", first["revision"].as_str()).await;
    assert_eq!(idle["changed"], false);
    // Latest-state identity coalesces A->B->A; no nonce is injected into legacy files.
    tokio::fs::write(&path, r#"{"flag":true,"draft":{"a":1,"z":2}}"#)
        .await
        .unwrap();
    assert_eq!(
        observe_at(&root, "one", first["revision"].as_str()).await["changed"],
        true
    );
    tokio::fs::write(&path, initial).await.unwrap();
    assert_eq!(
        observe_at(&root, "one", first["revision"].as_str()).await["changed"],
        false
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn authorization_is_checked_before_io_and_before_observation_returns() {
    let root = root();
    storage_at(
        &root,
        "one",
        "storage.set",
        &json!({"key":"draft","value":"private-marker"}),
        || Ok(()),
    )
    .await
    .unwrap();
    for deny_at in [0, 1] {
        let checks = AtomicUsize::new(0);
        let error = storage_at(&root, "one", "storage.observe", &json!({}), || {
            if checks.fetch_add(1, Ordering::SeqCst) == deny_at {
                Err(AppError::validation("test.revoked"))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("test.revoked"));
        assert!(!error.to_string().contains("private-marker"));
        assert_eq!(checks.load(Ordering::SeqCst), deny_at + 1);
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn invalid_keys_json_numbers_depth_and_unbounded_storage_are_redacted_without_repair() {
    let root = root();
    tokio::fs::create_dir(&root).await.unwrap();
    let mut too_deep = json!(null);
    for _ in 0..65 {
        too_deep = json!([too_deep]);
    }
    let cases = [
        "private-marker".into(),
        json!([]).to_string(),
        json!({"__proto__":"private-marker"}).to_string(),
        json!({"not/a/key":1}).to_string(),
        json!({"x":too_deep}).to_string(),
        json!({"x":9_007_199_254_740_992_u64}).to_string(),
        " ".repeat(super::super::MAX_STORAGE + 1),
    ];
    for raw in cases {
        let path = storage_path(&root, "one");
        tokio::fs::write(&path, &raw).await.unwrap();
        let error = storage_at(&root, "one", "storage.observe", &json!({}), || Ok(()))
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("private-marker"));
        assert!(
            error.to_string().contains("plugin.api.invalidStorage")
                || error.to_string().contains("plugin.api.storageTooLarge")
        );
        assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), raw);
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn concurrent_native_writes_preserve_all_keys_and_observations_settle_after_the_lock() {
    let root = root();
    let a = json!({"key":"a","value":1});
    let b = json!({"key":"b","value":2});
    let (a, b) = tokio::join!(
        storage_at(&root, "one", "storage.set", &a, || Ok(())),
        storage_at(&root, "one", "storage.set", &b, || Ok(()))
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        observe_at(&root, "one", None).await["snapshot"]["values"],
        json!({"a":1,"b":2})
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn maximum_storage_and_unicode_emit_actual_sdk_interoperability_fixture() {
    let root = root();
    tokio::fs::create_dir(&root).await.unwrap();
    let values = json!({"large":"x".repeat(super::super::MAX_STORAGE-12)});
    assert_eq!(
        serde_json::to_vec(&values).unwrap().len(),
        super::super::MAX_STORAGE
    );
    tokio::fs::write(
        storage_path(&root, "one"),
        serde_json::to_vec(&values).unwrap(),
    )
    .await
    .unwrap();
    let first = observe_at(&root, "one", None).await;
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_RESPONSE);
    let idle = observe_at(&root, "one", first["revision"].as_str()).await;
    let unicode=project("one",json!({"unicode":{"😀":"你好\n","__proto__":{"ok":true}},"numbers":[9_007_199_254_740_991_i64,0.25]}).as_object().unwrap().clone(),contracts::Observe::default()).unwrap();
    // Ryu emits 1e-6 while ECMAScript expands to0.000001. Exercise a
    // near-limit native map rather than assuming identical reserialization sizes.
    let decimals = json!({"numbers": vec![0.000001_f64; 50_000]});
    let decimal_bytes = serde_json::to_vec(&decimals).unwrap();
    assert!(decimal_bytes.len() <= super::super::MAX_STORAGE);
    tokio::fs::write(storage_path(&root, "one"), decimal_bytes)
        .await
        .unwrap();
    let decimal = observe_at(&root, "one", None).await;
    assert!(serde_json::to_vec(&decimal).unwrap().len() <= MAX_RESPONSE);
    if let Some(path) = std::env::var_os("TUNNELDE_STORAGE_CONTRACT_OUTPUT") {
        std::fs::write(
            path,
            serde_json::to_vec(
                &json!({"initial":first,"idle":idle,"unicode":unicode,"decimal":decimal}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}
