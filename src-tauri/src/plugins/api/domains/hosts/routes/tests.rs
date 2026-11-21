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

#[test]
fn native_route_commit_requires_original_origin_and_keeps_the_revision_contract() {
    use crate::services::operations::Authority;
    use std::sync::Mutex;
    struct Origin(Mutex<bool>);
    impl Authority for Origin {
        fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
            let live = self.0.lock().unwrap();
            if !*live {
                return Err(AppError::validation("origin.expired"));
            }
            effect()
        }
    }
    let db = db::Database::in_memory().unwrap();
    let security = crate::plugins::security::PluginSecurity::default();
    let declared: Vec<_> = WRITE.iter().map(|s| s.to_string()).collect();
    let digest = "a".repeat(64);
    security
        .set_permissions(
            &db,
            "router",
            digest.clone(),
            &declared,
            Some(declared.clone()),
        )
        .unwrap();
    let lease = security.lease("router", digest, declared).unwrap();
    let original = db
        .with(|conn| {
            let id = add_host(conn, "host")?;
            snapshot(conn, &id)
        })
        .unwrap();
    let route = ConnectionRoute {
        proxy: "direct".into(),
        ..Default::default()
    };
    let origin = Origin(Mutex::new(true));
    let (updated, changed) = security
        .with_authorized_fenced_database(
            &db,
            &lease,
            WRITE,
            || Ok(()),
            Some(&origin),
            |conn| {
                save(conn, &original.host_id, &original.revision, &route, || {
                    Ok(())
                })
            },
        )
        .unwrap();
    assert!(changed);
    assert_eq!(updated.route, route);
    assert_ne!(updated.revision, original.revision);
    assert!(security
        .with_authorized_fenced_database(
            &db,
            &lease,
            WRITE,
            || Ok(()),
            Some(&origin),
            |conn| save(
                conn,
                &original.host_id,
                &original.revision,
                &original.route,
                || panic!("stale CAS admitted")
            ),
        )
        .is_err());
    *origin.0.lock().unwrap() = false;
    let error = security
        .with_authorized_fenced_database(
            &db,
            &lease,
            WRITE,
            || Ok(()),
            Some(&origin),
            |conn| {
                save(
                    conn,
                    &updated.host_id,
                    &updated.revision,
                    &original.route,
                    || panic!("retired origin admitted"),
                )
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "origin.expired");
    assert_eq!(
        db.with(|conn| snapshot(conn, &updated.host_id))
            .unwrap()
            .revision,
        updated.revision
    );
}
