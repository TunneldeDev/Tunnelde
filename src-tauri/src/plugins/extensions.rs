//! Implemented extension points only. Discovery does not grant authority.
use serde_json::Value;
use std::sync::OnceLock;

pub(super) fn describe() -> Value {
    static CATALOGUE: OnceLock<Value> = OnceLock::new();
    CATALOGUE
        .get_or_init(|| {
            serde_json::from_str(include_str!("extensions.json"))
                .expect("embedded extension catalogue must be valid JSON")
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{api::METHODS, security::PERMISSIONS};
    use std::collections::HashSet;

    #[test]
    fn every_method_has_one_domain_and_every_point_uses_real_authorized_methods() {
        let catalogue = describe();
        assert_eq!(catalogue["version"], 1);
        assert_eq!(catalogue["layers"].as_array().unwrap().len(), 6);
        assert_eq!(
            catalogue["frontend"]["sdkVersion"],
            super::super::frontend::UI_SDK_VERSION
        );
        assert_eq!(catalogue["frontend"]["permission"], "ui.trusted");
        assert!(PERMISSIONS.contains(&"ui.trusted"));
        let providers = &catalogue["frontend"]["providers"];
        assert_eq!(providers["manifest"], "views[].provider");
        assert_eq!(
            providers["targets"],
            serde_json::json!([
                "hostList",
                "workbench",
                "fileBrowser",
                "terminal",
                "history",
                "forwarding",
                "monitor",
                "backgroundTasks",
                "processes"
            ])
        );
        assert_eq!(
            providers["monitorPermissions"],
            serde_json::json!(["sessions.read", "monitor.read"])
        );
        assert_eq!(providers["monitor"]["ownership"], "host-view");
        assert_eq!(
            providers["monitor"]["presentations"],
            serde_json::json!(["page", "panel"])
        );
        assert_eq!(providers["monitor"]["sampleLimit"], 240);
        assert_eq!(providers["monitor"]["pageSize"], 128);
        assert_eq!(providers["monitor"]["optionalSlot"], "Charts");
        assert_eq!(providers["monitor"]["sampling"], "shared-visible-consumers");
        assert_eq!(
            providers["monitor"]["refresh"],
            "coalesced-existing-sampler"
        );
        assert_eq!(
            providers["backgroundTasksPermissions"],
            serde_json::json!(["backgroundTasks.read"])
        );
        assert_eq!(
            providers["backgroundTasks"]["writePermission"],
            "backgroundTasks.write"
        );
        assert_eq!(providers["backgroundTasks"]["pageSize"], 128);
        assert_eq!(providers["backgroundTasks"]["pageTextLimit"], 65536);
        assert_eq!(catalogue["frontend"]["backgroundTasks"]["pendingLimit"], 8);
        assert_eq!(providers["selection"], "explicit-user");
        assert_eq!(providers["requiredSlot"], "Workspace");
        assert_eq!(providers["fallback"], "built-in");
        assert_eq!(providers["limits"]["perPlugin"], 8);
        assert_eq!(
            providers["processesPermissions"],
            serde_json::json!(["sessions.read", "monitor.read"])
        );
        assert_eq!(providers["processes"]["pageSize"], 128);
        assert_eq!(providers["processes"]["pageTextLimit"], 65536);
        assert_eq!(providers["processes"]["writePermission"], "monitor.write");
        assert_eq!(
            providers["processes"]["termination"],
            "native-confirmation-with-live-authorization-and-identity"
        );
        let domains = catalogue["domains"].as_array().unwrap();
        let mut ids = HashSet::new();
        let mut namespaces = HashSet::new();
        for domain in domains {
            assert!(ids.insert(domain["id"].as_str().unwrap()));
            for namespace in domain["namespaces"].as_array().unwrap() {
                assert!(
                    namespaces.insert(namespace.as_str().unwrap()),
                    "ambiguous namespace"
                );
            }
        }
        for method in METHODS.iter() {
            let namespace = method.name.split('.').next().unwrap();
            assert!(
                namespaces.contains(namespace),
                "unmapped method: {}",
                method.name
            );
        }
        for namespace in namespaces {
            assert!(
                METHODS
                    .iter()
                    .any(|method| method.name.split('.').next() == Some(namespace)),
                "unimplemented namespace: {namespace}"
            );
        }
        let mut points = HashSet::new();
        for point in catalogue["points"].as_array().unwrap() {
            assert!(points.insert(point["id"].as_str().unwrap()));
            assert!(ids.contains(point["domain"].as_str().unwrap()));
            assert_eq!(point["composition"], "merge");
            let permissions: Vec<_> = point["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            for permission in &permissions {
                assert!(PERMISSIONS.contains(permission));
            }
            if point["registration"]["manifest"].is_string() {
                if point["id"] == "hosts.fields" {
                    assert_eq!(point["registration"]["manifest"], "hostFields");
                    assert_eq!(point["ownership"], "manifest");
                    assert_eq!(point["concurrency"], "revision-and-schema-digest");
                    for (key, permission_key) in
                        [("read", "permissions"), ("replace", "writePermissions")]
                    {
                        let method = METHODS
                            .iter()
                            .find(|method| Some(method.name) == point["registration"][key].as_str())
                            .unwrap();
                        let declared: Vec<_> = point[permission_key]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|value| value.as_str().unwrap())
                            .collect();
                        assert_eq!(method.permissions, declared);
                        assert_eq!(method.stability, "experimental");
                    }
                    continue;
                }
                assert_eq!(point["id"], "hostList.menu");
                assert_eq!(point["registration"]["manifest"], "commands[].hostMenu");
                assert_eq!(point["ownership"], "manifest");
                assert_eq!(permissions, ["hosts.read"]);
                assert_eq!(point["limits"]["perPlugin"], 16);
                assert_eq!(point["limits"]["total"], 128);
                continue;
            }
            assert_eq!(point["ownership"], "runtime");
            if point["id"] == "hosts.sources" {
                let read = METHODS
                    .iter()
                    .find(|method| method.name == point["registration"]["read"].as_str().unwrap())
                    .unwrap();
                assert_eq!(read.permissions, ["hosts.read"]);
                assert_eq!(point["identity"], "owner-source-content-sha256");
                assert_eq!(point["limits"]["entriesTotal"], 4096);
            }
            for action in ["set", "remove"] {
                let name = point["registration"][action].as_str().unwrap();
                let method = METHODS
                    .iter()
                    .find(|method| method.name == name)
                    .expect("extension point references a nonexistent method");
                assert_eq!(method.permissions, permissions);
                assert_eq!(method.stability, point["stability"].as_str().unwrap());
            }
        }
    }
}
