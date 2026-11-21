use super::*;
use crate::models::HostInput;

fn add_host(conn: &Connection, name: &str) -> AppResult<String> {
    let input: HostInput = serde_json::from_value(json!({
        "name": name, "host": format!("{name}.test"), "authMethod": "agent",
    }))?;
    Ok(db::hosts::create_host(conn, &input.validate()?)?.id)
}

#[test]
fn native_route_edits_change_revision_even_when_the_original_route_is_restored() {
    let db = db::Database::in_memory().unwrap();
    db.with(|conn| {
        let host = add_host(conn, "host")?;
        let jump = add_host(conn, "jump")?;
        let original = snapshot(conn, &host)?;
        let route = ConnectionRoute {
            proxy: "direct".into(),
            jump_hosts: vec![jump.clone()],
        };
        assert_ne!(original.revision, snapshot(conn, &jump)?.revision);
        let (changed, wrote) = save(conn, &host, &original.revision, &route, || Ok(()))?;
        assert!(wrote);
        assert_ne!(changed.revision, original.revision);
        assert_eq!(changed.route, route);

        db::atomic(conn, |conn| {
            network::save_route_at(conn, &host, &original.route)
        })?;
        let restored = snapshot(conn, &host)?;
        assert_ne!(restored.revision, original.revision);
        assert_eq!(restored.route, original.route);
        assert!(save(conn, &host, &original.revision, &route, || panic!(
            "stale edit admitted"
        ))
        .is_err());

        let (unchanged, wrote) = save(conn, &host, &restored.revision, &restored.route, || Ok(()))?;
        assert!(!wrote);
        assert_eq!(unchanged.revision, restored.revision);
        Ok(())
    })
    .unwrap();
}

#[test]
fn invalid_routes_and_cancelled_admission_leave_state_unchanged() {
    let db = db::Database::in_memory().unwrap();
    db.with(|conn| {
        let host = add_host(conn, "host")?;
        let current = snapshot(conn, &host)?;
        for route in [
            ConnectionRoute {
                proxy: "invalid-proxy".into(),
                ..Default::default()
            },
            ConnectionRoute {
                jump_hosts: vec![host.clone()],
                ..Default::default()
            },
            ConnectionRoute {
                jump_hosts: vec!["missing".into()],
                ..Default::default()
            },
        ] {
            assert!(save(conn, &host, &current.revision, &route, || Ok(())).is_err());
            assert_eq!(snapshot(conn, &host)?.revision, current.revision);
        }
        let route = ConnectionRoute {
            proxy: "direct".into(),
            ..Default::default()
        };
        assert!(save(conn, &host, &current.revision, &route, || Err(
            AppError::validation("cancelled")
        ))
        .is_err());
        assert_eq!(snapshot(conn, &host)?.revision, current.revision);
        Ok(())
    })
    .unwrap();
}

#[test]
fn revoked_runtime_cannot_submit_a_captured_route_edit() {
    let db = db::Database::in_memory().unwrap();
    let security = crate::plugins::security::PluginSecurity::default();
    let fingerprint = "a".repeat(64);
    let declared = WRITE
        .iter()
        .map(|permission| (*permission).to_owned())
        .collect::<Vec<_>>();
    security
        .set_permissions(
            &db,
            "router",
            fingerprint.clone(),
            &declared,
            Some(declared.clone()),
        )
        .unwrap();
    let lease = security
        .lease("router", fingerprint.clone(), declared.clone())
        .unwrap();
    let current = db
        .with(|conn| {
            let host = add_host(conn, "host")?;
            snapshot(conn, &host)
        })
        .unwrap();
    security
        .set_permissions(
            &db,
            "router",
            fingerprint,
            &declared,
            Some(vec!["hosts.read".into()]),
        )
        .unwrap();
    let route = ConnectionRoute {
        proxy: "direct".into(),
        ..Default::default()
    };
    let result = security.with_authorized_database(
        &db,
        &lease,
        WRITE,
        || Ok(()),
        |conn| {
            save(conn, &current.host_id, &current.revision, &route, || {
                panic!("revoked edit admitted")
            })
        },
    );
    assert!(result.is_err());
    assert_eq!(
        db.with(|conn| snapshot(conn, &current.host_id))
            .unwrap()
            .revision,
        current.revision
    );
}
