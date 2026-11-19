use super::*;
use crate::db::Database;
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-import-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn payload() -> portable::Portable {
    let source = Database::in_memory().unwrap();
    let document = source
        .with(|conn| {
            let (target, _) = super::super::tests::fixture(conn);
            export_at(conn, &[target.id])
        })
        .unwrap();
    let hosts = document
        .hosts
        .iter()
        .map(|h| portable::HostSecret {
            host_id: h.id.clone(),
            password: Some("saved-password".into()),
            key_id: Some("shared-key".into()),
        })
        .collect();
    let proxies = document
        .proxies
        .iter()
        .map(|p| portable::ProxySecret {
            proxy_id: p.id.clone(),
            password: "proxy-password".into(),
        })
        .collect();
    portable::Portable {
        document,
        hosts,
        proxies,
        keys: vec![portable::KeySecret {
            id: "shared-key".into(),
            content: russh::keys::PrivateKey::random(
                &mut rand::rng(),
                russh::keys::Algorithm::Ed25519,
            )
            .unwrap()
            .encrypt(&mut rand::rng(), "original-key-passphrase")
            .unwrap()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes()
            .to_vec(),
        }],
    }
}
fn request(db: &Database, payload: &portable::Portable) -> FileRequest {
    FileRequest {
        token: "native-test".into(),
        revision: db.with(revision).unwrap(),
        selected: payload.document.roots.clone(),
        copies: false,
        mount_points: HashMap::new(),
    }
}
#[test]
fn encrypted_cross_database_import_restores_shared_keys_and_maps_credentials() {
    let payload = payload();
    let encrypted = crypto::encrypt(
        &zeroize::Zeroizing::new(serde_json::to_vec(&payload).unwrap()),
        "file-password",
    )
    .unwrap();
    let bytes = crypto::decrypt(&crypto::parse(&encrypted).unwrap(), "file-password").unwrap();
    let restored: portable::Portable = serde_json::from_slice(&bytes).unwrap();
    let db = Database::in_memory().unwrap();
    let root = Directory::new();
    let (applied, pending) =
        commit_import(&db, &root.0, &restored, request(&db, &restored), || Ok(())).unwrap();
    assert_eq!(applied.hosts.len(), 2);
    assert_eq!(pending.len(), 3);
    let paths: HashSet<_> = applied
        .hosts
        .iter()
        .map(|h| h.key_path.as_ref().unwrap())
        .collect();
    assert_eq!(paths.len(), 1);
    for path in paths {
        assert!(std::path::Path::new(path).starts_with(&root.0));
        assert_eq!(std::fs::read(path).unwrap(), payload.keys[0].content);
        assert!(russh::keys::load_secret_key(path, None).is_err());
        assert!(russh::keys::load_secret_key(path, Some("original-key-passphrase")).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    assert!(!applied.host_ids.values().any(|id| payload
        .document
        .hosts
        .iter()
        .any(|h| &h.id == id)));
    let proxy = db
        .with(db::settings::load_checked)
        .unwrap()
        .network
        .profiles[0]
        .clone();
    assert_ne!(proxy.id, payload.document.proxies[0].id);
}
#[test]
fn stale_cancelled_and_conflicting_imports_leave_no_keys_or_rows() {
    let payload = payload();
    for scenario in ["stale", "cancelled", "conflict"] {
        let db = Database::in_memory().unwrap();
        let root = Directory::new();
        let mut request = request(&db, &payload);
        if scenario == "stale" {
            request.revision = "outdated".into();
        }
        if scenario == "conflict" {
            db.with(|conn| {
                db::hosts::create_host(conn, &payload.document.hosts[0].input(None).validate()?)?;
                Ok(())
            })
            .unwrap();
            request.revision = db.with(revision).unwrap();
        }
        assert!(commit_import(&db, &root.0, &payload, request, || {
            if scenario == "cancelled" {
                Err(invalid())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
        assert_eq!(
            db.with(db::hosts::list_hosts).unwrap().len(),
            if scenario == "conflict" { 1 } else { 0 }
        );
    }
}
#[test]
fn strict_plain_schema_rejects_credentials_and_payload_rejects_dangling_secrets() {
    let mut payload = payload();
    let mut plain = serde_json::to_value(&payload.document).unwrap();
    plain["password"] = serde_json::json!("must-never-be-plaintext");
    assert!(serde_json::from_value::<Document>(plain).is_err());
    payload.hosts[0].key_id = Some("missing".into());
    assert!(payload.validate().is_err());
    payload.hosts[0].key_id = Some("shared-key".into());
    payload.keys[0].content = vec![0; 1024 * 1024 + 1];
    assert!(payload.validate().is_err());
}
#[test]
fn generated_passwords_are_random_url_safe_and_32_characters() {
    let a = hosts_export_password();
    let b = hosts_export_password();
    assert_ne!(a, b);
    assert_eq!(a.len(), 32);
    assert!(a
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
}

#[test]
fn secret_exports_cannot_bypass_encryption() {
    for (include_credentials, encrypt, password, allowed) in [
        (true, false, Some("password"), false),
        (true, true, None, false),
        (true, true, Some(""), false),
        (true, true, Some("password"), true),
        (false, false, None, true),
        (false, true, Some("password"), true),
    ] {
        assert_eq!(
            ExportOptions {
                include_credentials,
                encrypt,
                password: password.map(str::to_owned)
            }
            .validate()
            .is_ok(),
            allowed
        );
    }
}
