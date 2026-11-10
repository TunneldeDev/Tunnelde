use super::*;
use crate::plugins::{manifest, node, PluginStatus};
use serde_json::json;
use std::path::PathBuf;

struct Fixture {
    directory: PathBuf,
    db: Database,
    security: Arc<PluginSecurity>,
    instance: Instance,
    lease: Lease,
}

impl Fixture {
    fn new(runtime: &str, engines: serde_json::Value) -> Self {
        let directory =
            std::env::temp_dir().join(format!("tunnelde-preflight-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let entry = if runtime == "wasm" {
            "main.wasm"
        } else {
            "main.js"
        };
        let mut declaration = json!({
            "id":"sample", "name":"Sample", "version":"1.0.0", "apiVersion":1,
            "runtime":runtime, "main":entry, "engines": engines,
        });
        if runtime == "declarative" {
            declaration["views"] = json!([{"id":"main", "title":"Sample"}]);
        }
        std::fs::write(
            directory.join(manifest::MANIFEST_FILE),
            declaration.to_string(),
        )
        .unwrap();
        std::fs::write(
            directory.join(entry),
            if runtime == "wasm" {
                &b"\0asm\x01\0\0\0"[..]
            } else {
                &b"{}"[..]
            },
        )
        .unwrap();
        let instance = Instance::new(manifest::load(&directory).unwrap(), directory.clone());
        let db = Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        security
            .set_permissions(
                &db,
                "sample",
                instance.fingerprint.clone(),
                &[],
                Some(vec![]),
            )
            .unwrap();
        let lease = security
            .lease("sample", instance.fingerprint.clone(), vec![])
            .unwrap();
        Self {
            directory,
            db,
            security,
            instance,
            lease,
        }
    }

    async fn prepare(&self) -> AppResult<PreparedEngine> {
        prepare(
            &self.security,
            &self.lease,
            &self.instance,
            &self.db,
            &self.directory.join("runtimes"),
        )
        .await
    }

    fn unchanged(&self) {
        assert_eq!(self.instance.status, PluginStatus::Stopped);
        assert!(self.instance.host.is_none());
        assert!(self.instance.runtime_lease.is_none());
        assert!(self.instance.runtime_id.is_none());
        self.security
            .authorize(
                "sample",
                &self.lease.fingerprint,
                &self.lease.permissions,
                None,
                Some(self.lease.generation),
            )
            .unwrap();
        assert_eq!(
            self.security.is_ready(&self.lease).unwrap_err().to_string(),
            "plugin.notRunning"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[tokio::test]
async fn passive_preflight_never_starts_an_engine_or_probes_node() {
    let f = Fixture::new("declarative", json!({}));
    let probes = node::probe_count_for_test();
    assert!(matches!(
        f.prepare().await.unwrap(),
        PreparedEngine::Passive
    ));
    assert_eq!(node::probe_count_for_test(), probes);
    f.unchanged();
}

#[tokio::test]
async fn matching_fingerprint_does_not_authorize_stale_in_memory_manifest_metadata() {
    let mut f = Fixture::new("declarative", json!({}));
    // Simulate a scan that parsed the old manifest but hashed the new bytes.
    f.instance.manifest.version = "0.9.0".into();
    assert_eq!(f.instance.fingerprint, f.lease.fingerprint);
    assert_eq!(
        f.prepare().await.err().unwrap().to_string(),
        "pluginSecurity.changed"
    );
    f.unchanged();
    f.instance.manifest.version = "1.0.0".into();
    assert!(f.prepare().await.is_ok());
}

#[tokio::test]
async fn stale_entry_runtime_permissions_and_engine_ranges_are_not_lent_to_current_bytes() {
    let mut f = Fixture::new("declarative", json!({}));
    let original = f.instance.manifest.clone();
    f.instance.manifest.main = "other.js".into();
    assert!(f.prepare().await.is_err());
    f.instance.manifest = original.clone();
    f.instance.manifest.runtime = Some("node".into());
    assert!(f.prepare().await.is_err());
    f.instance.manifest = original.clone();
    f.instance.manifest.permissions = vec!["log".into()];
    assert!(f.prepare().await.is_err());
    f.instance.manifest = original.clone();
    f.instance
        .manifest
        .engines
        .insert("node".into(), ">=999.0.0".into());
    assert!(f.prepare().await.is_err());
    f.instance.manifest = original;
    f.unchanged();
    assert!(f.prepare().await.is_ok());
}

#[tokio::test]
async fn changed_entry_bytes_fail_without_retiring_the_original_grant() {
    let f = Fixture::new("declarative", json!({}));
    std::fs::write(f.directory.join("main.js"), "changed").unwrap();
    assert_eq!(
        f.prepare().await.err().unwrap().to_string(),
        "pluginSecurity.changed"
    );
    f.unchanged();
    std::fs::write(f.directory.join("main.js"), "{}").unwrap();
    assert!(f.prepare().await.is_ok());
}

#[tokio::test]
async fn incompatible_host_preserves_structured_diagnostic_before_runtime_registration() {
    let f = Fixture::new("node", json!({"tunnelde":">=999.0.0"}));
    let probes = node::probe_count_for_test();
    let error = f.prepare().await.err().unwrap();
    assert!(matches!(
        error,
        crate::error::AppError::PluginEngineUnsupported { .. }
    ));
    let detail = serde_json::to_value(error).unwrap();
    assert_eq!(detail["details"]["pluginId"], "sample");
    assert_eq!(detail["details"]["required"], ">=999.0.0");
    assert_eq!(node::probe_count_for_test(), probes);
    f.unchanged();
}

#[tokio::test]
async fn node_without_consent_is_never_probed_and_does_not_register_a_live_runtime() {
    let f = Fixture::new("node", json!({}));
    let probes = node::probe_count_for_test();
    assert_eq!(
        f.prepare().await.err().unwrap().to_string(),
        "node.required"
    );
    assert_eq!(node::probe_count_for_test(), probes);
    f.unchanged();
}

#[tokio::test]
async fn wasm_is_compiled_before_runtime_registration_and_failed_preparation_is_retryable() {
    let mut f = Fixture::new("wasm", json!({}));
    f.instance.wasm = None;
    assert!(matches!(
        f.prepare().await.unwrap(),
        PreparedEngine::Wasm(Some(_))
    ));
    f.unchanged();
    std::fs::write(f.directory.join("main.wasm"), "invalid wasm").unwrap();
    // A corrupt but approved package still must not be registered as running.
    f.instance.fingerprint = crate::plugins::security::fingerprint(&f.directory).unwrap();
    f.security
        .set_permissions(
            &f.db,
            "sample",
            f.instance.fingerprint.clone(),
            &[],
            Some(vec![]),
        )
        .unwrap();
    f.lease = f
        .security
        .lease("sample", f.instance.fingerprint.clone(), vec![])
        .unwrap();
    assert!(f
        .prepare()
        .await
        .err()
        .unwrap()
        .to_string()
        .starts_with("plugin.wasm.invalid"));
    f.unchanged();
}

#[tokio::test]
async fn old_grant_and_retired_instance_are_rejected_before_any_runtime_preparation() {
    let mut f = Fixture::new("declarative", json!({}));
    f.instance.retired = true;
    assert_eq!(
        f.prepare().await.err().unwrap().to_string(),
        "pluginSecurity.changed"
    );
    f.instance.retired = false;
    f.security.retire_runtime("sample");
    assert_eq!(
        f.prepare().await.err().unwrap().to_string(),
        "pluginSecurity.changed"
    );
}

#[tokio::test]
async fn unsupported_ui_sdk_is_checked_without_activation_and_retains_its_details() {
    let mut f = Fixture::new("declarative", json!({}));
    std::fs::create_dir(f.directory.join("ui")).unwrap();
    std::fs::write(
        f.directory.join("ui/main.mjs"),
        "export function activate() {}",
    )
    .unwrap();
    f.instance.manifest.runtime = Some("frontend".into());
    f.instance.manifest.main.clear();
    f.instance.manifest.views.clear();
    f.instance.manifest.permissions = vec!["ui.trusted".into()];
    f.instance.manifest.frontend = Some(crate::plugins::frontend::FrontendManifest {
        entry: "ui/main.mjs".into(),
        sdk: ">=999.0.0".into(),
    });
    std::fs::write(
        f.directory.join(manifest::MANIFEST_FILE),
        serde_json::to_vec(&f.instance.manifest).unwrap(),
    )
    .unwrap();
    f.instance = Instance::new(manifest::load(&f.directory).unwrap(), f.directory.clone());
    f.security
        .set_permissions(
            &f.db,
            "sample",
            f.instance.fingerprint.clone(),
            &f.instance.manifest.permissions,
            Some(f.instance.manifest.permissions.clone()),
        )
        .unwrap();
    f.lease = f
        .security
        .lease(
            "sample",
            f.instance.fingerprint.clone(),
            f.instance.manifest.permissions.clone(),
        )
        .unwrap();
    let probes = node::probe_count_for_test();
    let error = f.prepare().await.err().unwrap();
    assert!(matches!(
        error,
        crate::error::AppError::PluginUiSdkUnsupported { .. }
    ));
    let detail = serde_json::to_value(error).unwrap();
    assert_eq!(detail["details"]["required"], ">=999.0.0");
    assert_eq!(
        detail["details"]["available"],
        crate::plugins::frontend::UI_SDK_VERSION
    );
    assert_eq!(node::probe_count_for_test(), probes);
    f.unchanged();
}

#[tokio::test]
async fn wasm_preparation_preserves_a_loaded_module_but_recompiles_a_retired_runtime() {
    let mut f = Fixture::new("wasm", json!({}));
    assert!(matches!(
        f.prepare().await.unwrap(),
        PreparedEngine::Wasm(None)
    ));
    f.instance.runtime_lease = Some(f.lease.clone());
    assert!(matches!(
        f.prepare().await.unwrap(),
        PreparedEngine::Wasm(None)
    ));
    f.security.retire_runtime("sample");
    f.lease = f
        .security
        .lease("sample", f.instance.fingerprint.clone(), vec![])
        .unwrap();
    assert!(matches!(
        f.prepare().await.unwrap(),
        PreparedEngine::Wasm(Some(_))
    ));
    assert_ne!(
        f.instance.runtime_lease.as_ref().unwrap().generation,
        f.lease.generation
    );
}
