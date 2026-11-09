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
        for method in METHODS {
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
                assert_eq!(point["id"], "hostList.menu");
                assert_eq!(point["registration"]["manifest"], "commands[].hostMenu");
                assert_eq!(point["ownership"], "manifest");
                assert_eq!(permissions, ["hosts.read"]);
                assert_eq!(point["limits"]["perPlugin"], 16);
                assert_eq!(point["limits"]["total"], 128);
                continue;
            }
            assert_eq!(point["ownership"], "runtime");
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
