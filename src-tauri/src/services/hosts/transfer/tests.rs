use super::*;
use crate::{db::Database, models::GroupInput};
fn host(conn: &Connection, name: &str, address: &str, folder: Option<String>) -> Host {
    let input:HostInput=serde_json::from_value(serde_json::json!({"name":name,"host":address,"username":"tester","authMethod":"key","keyPath":"/private/keys/source-only","groupId":folder,"favorite":true,"tags":["work"],"note":"host notes"})).unwrap();
    db::hosts::create_host(conn, &input.validate().unwrap()).unwrap()
}
fn fixture(conn: &Connection) -> (Host, Host) {
    let parent = db::hosts::create_group(conn, "Work", None).unwrap();
    let child = db::hosts::create_group(conn, "Production", Some(&parent.id)).unwrap();
    let jump = host(conn, "Jump", "jump.example", Some(parent.id));
    let target = host(conn, "Target", "target.example", Some(child.id));
    crate::db::atomic(conn,|conn|{
        let mut settings=db::settings::load_checked(conn)?;
        settings.network.profiles.push(ProxyProfile{id:"proxy1".into(),name:"Work proxy".into(),protocol:"socks5".into(),host:"127.0.0.1".into(),port:1080,username:"proxy-user".into()});
        settings.network.features.insert("ssh".into(),"proxy1".into());db::settings::save(conn,&settings)?;
        crate::network::save_route_at(conn,&target.id,&ConnectionRoute{proxy:"".into(),jump_hosts:vec![jump.id.clone()]})?;
        let group=forwarding::groups::save_at(conn,None,&target.id,"Database",None)?;
        let rule=serde_json::from_value(serde_json::json!({"id":"f1","hostId":target.id,"name":"postgres","mode":"local","bindHost":"127.0.0.1","bindPort":5433,"targetHost":"127.0.0.1","targetPort":5432})).unwrap();
        forwarding::repository::import_at(conn,&rule,forwarding::automation::Options{auto_start:true,auto_retry:true},Some(&group.id))?;
        let group=mounts::contract::Group{id:"mountgroup".into(),host_id:target.id.clone(),name:"Files".into(),auto_reconnect:true};
        mounts::repository::save(conn,mounts::contract::Save{value:group.clone(),expected_revision:None})?;
        let mount_point=if cfg!(windows){"Z:\\"}else{"/tmp/tunnelde-test-mount"};
        mounts::repository::save(conn,mounts::contract::Save{value:mounts::contract::Rule{id:"mount1".into(),host_id:target.id.clone(),group_id:group.id,name:"Source".into(),remote_path:"/srv/source".into(),mount_point:mount_point.into(),read_only:true,auto_mount:true},expected_revision:None})?;
        Ok(())
    }).unwrap();
    (target, jump)
}
fn request(conn: &Connection, document: Document, copies: bool) -> ImportRequest {
    let preview = preview_at(conn, document).unwrap();
    serde_json::from_value(serde_json::json!({"document":preview.document,"revision":preview.revision,"selected":preview.document.roots,"copies":copies})).unwrap()
}
#[test]
fn one_host_round_trip_includes_dependencies_and_remaps_all_relationships_without_secrets() {
    let source = Database::in_memory().unwrap();
    let target = Database::in_memory().unwrap();
    let document = source
        .with(|conn| {
            let (target, _) = fixture(conn);
            export_at(conn, &[target.id])
        })
        .unwrap();
    assert_eq!(document.hosts.len(), 2);
    assert_eq!(document.proxies.len(), 1);
    assert_eq!(document.folders.len(), 2);
    assert!(document.hosts.iter().all(|h| h.route.proxy == "proxy1"));
    let raw = serde_json::to_string(&document).unwrap();
    for forbidden in [
        "keyPath",
        "/private/keys",
        "password",
        "passphrase",
        "sessionId",
        "runtimeId",
        "revision",
    ] {
        assert!(!raw.contains(forbidden), "{forbidden}");
    }
    target
        .with(|conn| {
            let old: HashSet<_> = document.hosts.iter().map(|h| h.id.clone()).collect();
            let imported = apply_at(conn, request(conn, document.clone(), false))?;
            assert_eq!(imported.len(), 2);
            assert!(imported
                .iter()
                .all(|h| !old.contains(&h.id) && h.key_path.is_none()));
            let target = imported.iter().find(|h| h.name == "Target").unwrap();
            let jump = imported.iter().find(|h| h.name == "Jump").unwrap();
            let route = crate::network::route_at(conn, &target.id)?;
            assert_eq!(route.jump_hosts, vec![jump.id.clone()]);
            assert_ne!(route.proxy, "proxy1");
            let network = db::settings::load_checked(conn)?.network;
            assert_eq!(network.profiles.len(), 1);
            assert_eq!(route.proxy, network.profiles[0].id);
            let forwards = forwarding::repository::list_conn(conn)?;
            assert_eq!(forwards.len(), 1);
            let f = &forwards[0];
            assert_eq!(f.rule.host_id, target.id);
            assert_ne!(f.rule.id, "f1");
            let group = forwarding::groups::list(conn, Some(&target.id))?.remove(0);
            assert_eq!(f.group_id.as_deref(), Some(group.id.as_str()));
            assert_eq!(
                forwarding::automation::settings::read(conn, &f.rule.id, &f.revision)?,
                forwarding::automation::Options {
                    auto_start: true,
                    auto_retry: true
                }
            );
            let rules = mounts::repository::all::<mounts::contract::Rule>(conn, None)?;
            let groups = mounts::repository::all::<mounts::contract::Group>(conn, None)?;
            assert_eq!(rules[0].value.host_id, target.id);
            assert_eq!(rules[0].value.group_id, groups[0].value.id);
            assert_ne!(rules[0].value.id, "mount1");
            assert_eq!(db::hosts::list_groups(conn)?.len(), 2);
            assert!(target.group_id.is_some());
            Ok(())
        })
        .unwrap();
}
#[test]
fn conflicts_are_skipped_unless_explicitly_copied_and_existing_hosts_never_change() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let original = host(conn, "Server", "host.example", None);
        let document = export_at(conn, std::slice::from_ref(&original.id))?;
        assert!(preview_at(conn, document.clone())?.entries[0].conflict);
        assert!(apply_at(conn, request(conn, document.clone(), false)).is_err());
        assert_eq!(db::hosts::list_hosts(conn)?.len(), 1);
        let imported = apply_at(conn, request(conn, document, true))?;
        assert_eq!(imported.len(), 1);
        assert_ne!(imported[0].id, original.id);
        let unchanged = db::hosts::find_host(conn, &original.id)?;
        assert_eq!(unchanged.key_path, original.key_path);
        assert_eq!(unchanged.name, "Server");
        Ok(())
    })
    .unwrap();
}
#[test]
fn stale_preview_and_write_failure_leave_no_partial_import() {
    let source = Database::in_memory().unwrap();
    let target = Database::in_memory().unwrap();
    let document = source
        .with(|conn| {
            let (target, _) = fixture(conn);
            export_at(conn, &[target.id])
        })
        .unwrap();
    target.with(|conn|{
        let stale=request(conn,document.clone(),false);db::hosts::create_group(conn,&GroupInput{name:"Changed".into(),parent_id:None}.validate()?.0,None)?;
        assert!(apply_at(conn,stale).is_err());assert!(db::hosts::list_hosts(conn)?.is_empty());
        let request=request(conn,document,false);
        conn.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON mount_rules BEGIN SELECT RAISE(ABORT,'injected failure'); END;")?;
        assert!(apply_at(conn,request).is_err());assert!(db::hosts::list_hosts(conn)?.is_empty());assert_eq!(db::hosts::list_groups(conn)?.len(),1);
        assert!(forwarding::repository::list_conn(conn)?.is_empty());assert!(forwarding::groups::list(conn,None)?.is_empty());assert!(db::settings::load_checked(conn)?.network.profiles.is_empty());
        Ok(())
    }).unwrap();
}
#[test]
fn cyclic_missing_and_cross_host_dependencies_are_rejected_before_writes() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let (host, _) = fixture(conn);
        let valid = export_at(conn, &[host.id])?;
        let mut broken = valid.clone();
        broken.hosts[0].route.jump_hosts = vec!["missing".into()];
        assert!(validate(&broken).is_err());
        let mut broken = valid.clone();
        broken.hosts[0].route.jump_hosts = vec![broken.hosts[0].id.clone()];
        assert!(validate(&broken).is_err());
        let mut broken = valid.clone();
        broken.forwards[0].rule.host_id = broken
            .hosts
            .iter()
            .find(|h| h.id != broken.forwards[0].rule.host_id)
            .unwrap()
            .id
            .clone();
        assert!(validate(&broken).is_err());
        let mut unknown = serde_json::to_value(valid)?;
        unknown["hosts"][0]["password"] = "must-not-import".into();
        assert!(serde_json::from_value::<Document>(unknown).is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn batch_export_includes_only_selected_hosts_and_their_dependency_closure() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let a = host(conn, "A", "a.example", None);
        let b = host(conn, "B", "b.example", None);
        let _c = host(conn, "C", "c.example", None);
        let document = export_at(conn, &[a.id, b.id])?;
        assert_eq!(document.hosts.len(), 2);
        assert_eq!(document.roots.len(), 2);
        Ok(())
    })
    .unwrap();
}
