use super::*;
use crate::{db, models::HostInput};

#[test]
fn prompt_revision_excludes_cosmetics_but_covers_every_connection_input() {
    db::Database::in_memory()
        .unwrap()
        .with(|conn| {
            let input: HostInput = serde_json::from_value(serde_json::json!({
                "name":"Display name","host":"original","username":"qa"
            }))
            .unwrap();
            let original = db::hosts::create_host(conn, &input.validate()?)?;
            let node = |host| Node {
                host,
                key: Some("SHA256:original".into()),
            };
            let route = ConnectionRoute::default();
            let value = |nodes: &[Node], route: &ConnectionRoute, transport: &str| {
                revision(nodes, route, |digest| digest.update(transport.as_bytes()))
            };
            let expected = value(&[node(original.clone())], &route, "proxy");
            assert_eq!(expected.len(), 64);
            let mut renamed = original.clone();
            renamed.name = "Renamed".into();
            renamed.favorite = true;
            renamed.tags = vec!["tag".into()];
            renamed.updated_at = 99;
            assert_eq!(expected, value(&[node(renamed)], &route, "proxy"));
            for field in 0..6 {
                let mut changed = original.clone();
                match field {
                    0 => changed.id = "different-id".into(),
                    1 => changed.host = "replacement".into(),
                    2 => changed.port = 2222,
                    3 => changed.username = "another-user".into(),
                    4 => changed.auth_method = "key".into(),
                    _ => changed.key_path = Some("different-key".into()),
                }
                assert_ne!(expected, value(&[node(changed)], &route, "proxy"));
            }
            let mut changed = node(original.clone());
            changed.key = None;
            assert_ne!(expected, value(&[changed], &route, "proxy"));
            assert_ne!(
                expected,
                value(
                    &[node(original.clone())],
                    &route,
                    "changed-proxy-credentials"
                )
            );
            let changed_route = ConnectionRoute {
                proxy: "other-selection".into(),
                ..route.clone()
            };
            assert_ne!(expected, value(&[node(original)], &changed_route, "proxy"));
            Ok(())
        })
        .unwrap();
}

#[test]
fn prompt_revision_preserves_order_and_all_jump_trust_baselines() {
    let host = |id: &str| {
        serde_json::from_value(serde_json::json!({
            "id":id,"groupId":null,"name":id,"host":id,"port":22,"username":"qa",
            "authMethod":"password","keyPath":null,"favorite":false,"color":null,
            "tags":[],"note":null,"sortOrder":0,"lastUsedAt":null,"createdAt":0,"updatedAt":0
        }))
        .unwrap()
    };
    let mut nodes = vec![
        Node {
            host: host("jump"),
            key: Some("jump-key".into()),
        },
        Node {
            host: host("target"),
            key: Some("target-key".into()),
        },
    ];
    let route = ConnectionRoute {
        proxy: "direct".into(),
        jump_hosts: vec!["jump".into()],
    };
    let value = |nodes: &[Node]| revision(nodes, &route, |_| {});
    let expected = value(&nodes);
    nodes[0].key = Some("new-jump-key".into());
    assert_ne!(expected, value(&nodes));
    nodes[0].key = Some("jump-key".into());
    assert_eq!(expected, value(&nodes));
    nodes.reverse();
    assert_ne!(expected, value(&nodes));
}
