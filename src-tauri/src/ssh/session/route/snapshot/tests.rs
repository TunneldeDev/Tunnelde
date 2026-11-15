use super::*;
use crate::{db::Database, models::HostInput};

fn host(conn: &rusqlite::Connection, name: &str) -> Host {
    let input: HostInput = serde_json::from_value(serde_json::json!({
        "name":name,"host":format!("{name}.example"),"username":"qa"
    }))
    .unwrap();
    db::hosts::create_host(conn, &input.validate().unwrap()).unwrap()
}

fn save_route(conn: &rusqlite::Connection, id: &str, route: &ConnectionRoute) {
    conn.execute(
        "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,0)",
        rusqlite::params![format!("route:{id}"), serde_json::to_string(route).unwrap()],
    )
    .unwrap();
}

#[test]
fn captures_the_complete_ordered_route_before_any_hop_can_be_edited() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let first = host(conn, "first");
            let second = host(conn, "second");
            let target = host(conn, "target");
            let route = ConnectionRoute {
                proxy: "direct".into(),
                jump_hosts: vec![first.id.clone(), second.id.clone()],
            };
            save_route(conn, &target.id, &route);
            let nodes = capture_nodes(conn, &target, &route)?;
            assert_eq!(
                nodes
                    .iter()
                    .map(|node| node.host.id.as_str())
                    .collect::<Vec<_>>(),
                [first.id.as_str(), second.id.as_str(), target.id.as_str()]
            );
            conn.execute(
                "UPDATE hosts SET host='replacement.example' WHERE id=?1",
                [&second.id],
            )?;
            assert_eq!(nodes[1].host.host, "second.example");
            assert_eq!(
                verify_configuration(conn, &target.id, &route, &nodes)
                    .unwrap_err()
                    .to_string(),
                "ssh.connectionChanged"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn rejects_cycles_duplicate_hops_and_overlong_routes_before_acquisition() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let target = host(conn, "target");
            let jump = host(conn, "jump");
            for jumps in [
                vec![target.id.clone()],
                vec![jump.id.clone(), jump.id.clone()],
                vec![jump.id.clone(); 9],
            ] {
                let route = ConnectionRoute {
                    proxy: "direct".into(),
                    jump_hosts: jumps,
                };
                assert_eq!(
                    capture_nodes(conn, &target, &route)
                        .err()
                        .unwrap()
                        .to_string(),
                    "network.jumpCycle"
                );
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn rejects_each_credential_or_endpoint_change_and_deleted_hosts() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let target = host(conn, "target");
            let nodes = capture_nodes(conn, &target, &ConnectionRoute::default())?;
            for (field, value) in [
                ("host", "replacement.example"),
                ("port", "2222"),
                ("username", "someone-else"),
                ("auth_method", "key"),
                ("key_path", "/a/different/key"),
            ] {
                let original: rusqlite::types::Value = conn.query_row(
                    &format!("SELECT {field} FROM hosts WHERE id=?1"),
                    [&target.id],
                    |row| row.get(0),
                )?;
                conn.execute(
                    &format!("UPDATE hosts SET {field}=?2 WHERE id=?1"),
                    rusqlite::params![target.id, value],
                )?;
                assert_eq!(
                    verify_nodes(conn, &nodes).unwrap_err().to_string(),
                    "ssh.connectionChanged"
                );
                conn.execute(
                    &format!("UPDATE hosts SET {field}=?2 WHERE id=?1"),
                    rusqlite::params![target.id, original],
                )?;
                verify_nodes(conn, &nodes)?;
            }
            db::hosts::delete_host(conn, &target.id)?;
            assert_eq!(
                verify_nodes(conn, &nodes).unwrap_err().to_string(),
                "ssh.connectionChanged"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn cosmetic_host_metadata_does_not_change_connection_authority() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let target = host(conn, "target");
            let nodes = capture_nodes(conn, &target, &ConnectionRoute::default())?;
            conn.execute("UPDATE hosts SET name='Renamed', favorite=1, color='blue', tags='[\"production\"]', note='edited', sort_order=99,last_used_at=123,updated_at=456 WHERE id=?1", [&target.id])?;
            verify_nodes(conn, &nodes)
        })
        .unwrap();
}

#[test]
fn trust_revocation_or_replacement_invalidates_pending_authentication() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let target = host(conn, "target");
            db::known_hosts::upsert(conn, &target.host, 22, "ssh-ed25519", "SHA256:original")?;
            let nodes = capture_nodes(conn, &target, &ConnectionRoute::default())?;
            db::known_hosts::upsert(
                conn,
                "unrelated.example",
                22,
                "ssh-ed25519",
                "SHA256:unrelated",
            )?;
            verify_nodes(conn, &nodes)?;
            db::known_hosts::upsert(conn, &target.host, 22, "ssh-ed25519", "SHA256:replacement")?;
            assert!(verify_nodes(conn, &nodes).is_err());
            db::known_hosts::forget(conn, &target.host, 22)?;
            assert!(verify_nodes(conn, &nodes).is_err());
            db::known_hosts::upsert(conn, &target.host, 22, "ssh-ed25519", "SHA256:original")?;
            verify_nodes(conn, &nodes)
        })
        .unwrap();
}

#[test]
fn route_order_and_proxy_selection_are_checked_at_admission() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let first = host(conn, "first");
            let second = host(conn, "second");
            let target = host(conn, "target");
            let route = ConnectionRoute {
                proxy: "direct".into(),
                jump_hosts: vec![first.id, second.id],
            };
            save_route(conn, &target.id, &route);
            let nodes = capture_nodes(conn, &target, &route)?;
            verify_configuration(conn, &target.id, &route, &nodes)?;
            let mut reordered = route.clone();
            reordered.jump_hosts.reverse();
            save_route(conn, &target.id, &reordered);
            assert!(verify_configuration(conn, &target.id, &route, &nodes).is_err());
            let mut proxy = route.clone();
            proxy.proxy = "another-profile".into();
            save_route(conn, &target.id, &proxy);
            assert!(verify_configuration(conn, &target.id, &route, &nodes).is_err());
            save_route(conn, &target.id, &route);
            verify_configuration(conn, &target.id, &route, &nodes)
        })
        .unwrap();
}

#[test]
fn a_displayed_host_changed_while_queued_is_rejected_before_transport_read() {
    use std::future::{poll_fn, Future};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::task::Poll;
    use std::time::Duration;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        for (field, value) in [("username", "changed"), ("host", "replacement.example")] {
            let database = Arc::new(Database::in_memory().unwrap());
            let displayed = database.with(|conn| Ok(host(conn, "target"))).unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            ready.await.unwrap();
            let owned = database.clone();
            let host_id = displayed.id.clone();
            let reads = Arc::new(AtomicUsize::new(0));
            let observed = reads.clone();
            let mut request = Box::pin(crate::services::credentials::inspect(move || {
                owned.with(|conn| capture_configuration(conn, &displayed))?;
                // Models only the next transport-read boundary. This is a
                // deterministic worker/DB regression, not a native Vault test.
                observed.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }));
            // Polling posts the real inspect worker behind the sole blocker.
            poll_fn(|cx| {
                assert!(request.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            assert_eq!(reads.load(Ordering::Acquire), 0);
            database
                .with(|conn| {
                    conn.execute(
                        &format!("UPDATE hosts SET {field}=?2 WHERE id=?1"),
                        rusqlite::params![host_id, value],
                    )?;
                    Ok(())
                })
                .unwrap();
            release.send(()).unwrap();
            blocker.await.unwrap();
            assert_eq!(
                request.await.unwrap_err().to_string(),
                "ssh.connectionChanged"
            );
            assert_eq!(reads.load(Ordering::Acquire), 0);
        }
    });
}

#[test]
fn capture_preflight_preserves_cosmetic_edits_and_route_errors() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let target = host(conn, "target");
            conn.execute("UPDATE hosts SET name='renamed' WHERE id=?1", [&target.id])?;
            let (_, nodes) = capture_configuration(conn, &target)?;
            assert_eq!(nodes.last().unwrap().host.name, target.name);
            save_route(
                conn,
                &target.id,
                &ConnectionRoute {
                    proxy: "direct".into(),
                    jump_hosts: vec![target.id.clone()],
                },
            );
            assert_eq!(
                capture_configuration(conn, &target)
                    .err()
                    .unwrap()
                    .to_string(),
                "network.jumpCycle"
            );
            save_route(conn, &target.id, &ConnectionRoute::default());
            db::hosts::delete_host(conn, &target.id)?;
            assert_eq!(
                capture_configuration(conn, &target)
                    .err()
                    .unwrap()
                    .to_string(),
                "ssh.connectionChanged"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn dynamic_preflight_reuses_destination_and_source_scope_checks() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let mut dynamic = host(conn, "dynamic");
            dynamic.id = format!("{}owned", crate::plugins::host_sources::PREFIX);
            let node = Node {
                host: dynamic.clone(),
                key: None,
            };
            verify_dynamic(std::slice::from_ref(&node), |_| Ok(dynamic.clone()))?;
            let mut edited = dynamic.clone();
            edited.username = "replacement".into();
            assert_eq!(
                verify_dynamic(std::slice::from_ref(&node), |_| Ok(edited.clone()))
                    .unwrap_err()
                    .to_string(),
                "ssh.connectionChanged"
            );
            assert_eq!(
                verify_dynamic(std::slice::from_ref(&node), |_| Err(AppError::validation(
                    "plugins.permissionDenied"
                )))
                .unwrap_err()
                .to_string(),
                "ssh.connectionChanged"
            );
            let saved = Node {
                host: host(conn, "saved"),
                key: None,
            };
            verify_dynamic(&[saved], |_| {
                panic!("saved hosts must not resolve dynamic source scope")
            })
        })
        .unwrap();
}

mod authority;
