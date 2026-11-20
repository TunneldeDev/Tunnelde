use super::*;
use crate::db::Database;
use serde_json::json;
fn request(value: Value) -> Request {
    let request: Request = serde_json::from_value(value).unwrap();
    request.validate().unwrap();
    request
}
fn host(conn: &rusqlite::Connection) -> String {
    let input: crate::models::HostInput =
        serde_json::from_value(json!({"name":"Provider host","host":"example.test"})).unwrap();
    crate::db::hosts::create_host(conn, &input.validate().unwrap())
        .unwrap()
        .id
}
fn save(host: &str) -> Value {
    json!({"operation":"save","rule":{"id":"","hostId":host,"name":"Rule","mode":"local","bindHost":"127.0.0.1","bindPort":8080,"targetHost":"localhost","targetPort":80},"revision":null,"groupId":null,"automation":{"autoStart":false,"autoRetry":false}})
}
#[test]
fn provider_target_is_fixed_to_original_builtin_host_and_rule_revision() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let selected = host(conn);
        let foreign = host(conn);
        assert!(Target::capture(&selected, &request(save(&foreign))).is_err());
        let target = Target::capture(&selected, &request(save(&selected)))?;
        target.check(conn, &selected)?;
        let mut wire = save(&selected);
        wire["rule"]["id"] = json!("rule");
        let rule: domain::contract::ForwardRule =
            serde_json::from_value(wire["rule"].clone()).unwrap();
        domain::repository::import_at(conn, &rule, Default::default(), None)?;
        let entry = domain::repository::list_conn(conn)?.pop().unwrap();
        wire["revision"] = json!(entry.revision);
        let target = Target::capture(&selected, &request(wire))?;
        target.check(conn, &selected)?;
        assert!(target.check(conn, &foreign).is_err());
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key='forward-version:rule'",
            [serde_json::to_string("replacement")?],
        )?;
        assert!(
            target.check(conn, &selected).is_err(),
            "later revision replaced original provider target"
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn groups_disconnects_and_reviewed_routes_cannot_escape_selected_host() {
    let db = Database::in_memory().unwrap();
    db.with(|conn|{
        let selected=host(conn);let foreign=host(conn);
        let group=domain::groups::save_at(conn,None,&foreign,"Other host",None)?;
        for operation in [json!({"operation":"saveGroup","hostId":foreign,"name":"Foreign"}),json!({"operation":"disconnect","hostId":foreign,"sessionId":"session","interaction":"original"})] {
            assert!(Target::capture(&selected,&request(operation)).is_err());
        }
        for operation in [json!({"operation":"removeGroup","id":group.id,"revision":group.revision}),json!({"operation":"saveGroup","hostId":selected,"id":group.id,"revision":group.revision,"name":"Retarget"})] {
            let target=Target::capture(&selected,&request(operation))?;
            assert!(target.check(conn,&selected).is_err());
        }
        let group=domain::groups::save_at(conn,None,&selected,"Selected",None)?;
        let target=Target::capture(&selected,&request(json!({"operation":"removeGroup","id":group.id,"revision":group.revision})))?;
        target.check(conn,&selected)?;
        domain::groups::save_at(conn,Some(&group.id),&selected,"Renamed",Some(&group.revision))?;
        assert!(target.check(conn,&selected).is_err());
        let operation=json!({"operation":"start","id":"rule","revision":"r1","interaction":"original","review":{"hostId":foreign,"revision":"a".repeat(64)}});
        let request: Request=serde_json::from_value(operation).unwrap();
        assert!(Target::capture(&selected,&request).is_err());
        Ok(())
    }).unwrap();
}
#[test]
fn provider_ingress_is_closed_and_cannot_forge_a_builtin_fallback_or_ownership() {
    let wire = json!({"action":"forwarding","token":"native-child","lease":{"panelId":"forwarding","windowId":"satellite","generation":2},"request":{"operation":"stop","id":"rule","revision":"r1","runtimeId":"instance"}});
    use crate::platform::panel_windows::plugin_views::gateway;
    assert!(serde_json::from_value::<gateway::Request>(wire.clone()).is_ok());
    for field in [
        "origin",
        "command",
        "permissions",
        "pluginId",
        "hostId",
        "builtin",
    ] {
        let mut forged = wire.clone();
        forged[field] = json!(true);
        assert!(
            serde_json::from_value::<gateway::Request>(forged).is_err(),
            "{field}"
        );
    }
    let mut nested = wire;
    nested["request"]["origin"] = json!({"token":"main","scope":"scope"});
    assert!(serde_json::from_value::<gateway::Request>(nested).is_err());
}
