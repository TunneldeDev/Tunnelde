use super::*;
use serde_json::json;
use std::collections::HashSet;

#[test]
fn discovery_preserves_legacy_fields_and_publishes_stability_metadata() {
    let entry = serde_json::to_value(method_info("api.describe").unwrap()).unwrap();
    assert_eq!(entry["name"], "api.describe");
    assert_eq!(entry["permissions"], json!([]));
    assert_eq!(entry["params"], "{}");
    assert!(entry["description"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(entry["stability"], "stable");
    assert_eq!(entry["since"], "0.21.0");
    assert_eq!(entry["deprecated"], Value::Null);
    let experimental = serde_json::to_value(method_info("workspace.openPage").unwrap()).unwrap();
    assert_eq!(experimental["stability"], "experimental");
    assert_eq!(experimental["since"], Value::Null);
}

// Source organization must not change existing method metadata or stable schemas.
#[test]
fn domain_catalogue_preserves_existing_method_contracts() {
    let previous: Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/plugin-compat/rpc-catalogue-v1/catalogue.json"
    ))
    .unwrap();
    let current = describe_api();
    let keyed = |value: &Value| -> std::collections::BTreeMap<String, Value> {
        value["methods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|method| (method["name"].as_str().unwrap().to_owned(), method.clone()))
            .collect()
    };
    assert_eq!(current["version"], previous["version"]);
    let actual = keyed(&current);
    let historical = keyed(&previous);
    for (name, contract) in &historical {
        assert_eq!(actual.get(name), Some(contract), "changed contract: {name}");
    }
    // New methods are explicit additions; keep every historical contract frozen.
    let added: Vec<_> = actual
        .keys()
        .filter(|name| !historical.contains_key(*name))
        .map(String::as_str)
        .collect();
    assert_eq!(
        added,
        [
            "preferences.schema",
            "preferences.snapshot",
            "preferences.update"
        ]
    );
}

// CI validates the actual serialized host response against the frozen v1 schema.
#[test]
fn emit_discovery_contract_response() {
    let response = describe_api();
    assert_eq!(response["version"], 1);
    assert!(response["methods"].as_array().unwrap().len() > 1);
    if let Some(path) = std::env::var_os("TUNNELDE_API_CONTRACT_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&response).unwrap()).unwrap();
    }
}

#[test]
fn exposes_only_unique_documented_methods_with_declared_permissions() {
    let mut names = HashSet::new();
    for entry in METHODS.iter() {
        assert!(
            names.insert(entry.name),
            "duplicate API method {}",
            entry.name
        );
        assert!(!entry.params.is_empty() && !entry.description.is_empty());
        assert!(matches!(
            entry.stability,
            "stable" | "experimental" | "deprecated"
        ));
        if entry.stability == "stable" {
            assert!(
                entry.since.is_some(),
                "stable method {} needs since",
                entry.name
            );
            assert!(
                entry.deprecated.is_none(),
                "stable method {} cannot be deprecated",
                entry.name
            );
        }
        if entry.stability == "deprecated" {
            assert!(
                entry.deprecated.is_some(),
                "deprecated method {} needs guidance",
                entry.name
            );
        }
        for permission in entry.permissions {
            assert!(
                super::super::security::PERMISSIONS.contains(permission),
                "unknown permission {permission}"
            );
        }
    }
    for forbidden in [
        "invoke",
        "commands.invoke",
        "vault.read",
        "credential.read",
        "ssh.trust",
        "plugin.start",
        "settings.reset",
    ] {
        assert!(method_info(forbidden).is_none());
    }
    assert_eq!(
        method_info("sessions.exec").unwrap().permissions,
        ["ssh.exec"]
    );
    assert_eq!(
        method_info("files.local.copy").unwrap().permissions,
        ["fs.read", "fs.write"]
    );
    let describe = method_info("api.describe").unwrap();
    assert_eq!(describe.stability, "stable");
    assert_eq!(describe.since, Some("0.21.0"));
}
