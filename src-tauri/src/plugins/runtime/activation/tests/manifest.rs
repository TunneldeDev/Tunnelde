use crate::plugins::manifest::{self, DEPENDENCY_API_VERSION};
use serde_json::{json, Value};

#[test]
fn required_dependencies_have_a_rejecting_gate_for_v1_hosts_and_strict_declarations() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-declaration-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("main.mjs"), "").unwrap();
    let base = json!({"id":"sample", "name":"Sample", "version":"1.0.0", "apiVersion":2,
        "runtime":"node", "main":"main.mjs", "dependencies":[{"id":"shared","version":"^1.0"}]});
    let load = |value: &Value| {
        std::fs::write(directory.join(manifest::MANIFEST_FILE), value.to_string()).unwrap();
        manifest::load(&directory)
    };
    let valid = load(&base).unwrap();
    assert_eq!(valid.api_version, DEPENDENCY_API_VERSION);
    assert_eq!(valid.dependencies[0].id, "shared");
    // The released v1 host's admission check was equality with API_VERSION=1.
    // A declaration requiring this executor must fail that unchanged check.
    assert_ne!(valid.api_version, manifest::API_VERSION);
    let mut legacy = base.clone();
    legacy["apiVersion"] = json!(1);
    assert_eq!(
        load(&legacy).unwrap_err().to_string(),
        "plugin.activation.declarationVersion"
    );
    legacy.as_object_mut().unwrap().remove("dependencies");
    assert!(load(&legacy).unwrap().dependencies.is_empty());
    assert!(serde_json::to_value(load(&legacy).unwrap())
        .unwrap()
        .get("dependencies")
        .is_none());
    for dependencies in [
        json!([{"id":"sample","version":"^1"}]),
        json!([{"id":"../shared","version":"^1"}]),
        json!([{"id":"shared","version":"^1","optional":true}]),
        json!([{"id":"shared","version":"1 || 2"}]),
        json!([{"id":"shared","version":"^1"},{"id":"shared","version":"^1"}]),
        json!(vec![json!({"id":"shared","version":"^1"}); 17]),
    ] {
        let mut invalid = base.clone();
        invalid["dependencies"] = dependencies;
        assert!(load(&invalid).is_err());
    }
    let mut theme = base.clone();
    theme["runtime"] = json!("theme");
    assert_eq!(
        load(&theme).unwrap_err().to_string(),
        "plugin.activation.declarationVersion"
    );
    std::fs::remove_dir_all(directory).unwrap();
}
