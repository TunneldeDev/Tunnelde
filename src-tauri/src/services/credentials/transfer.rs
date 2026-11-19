//! Native-only migration bridge. No raw credential command is exposed to plugins.
use super::*;
use zeroize::Zeroizing;

enum Authority {
    Host(authority::HostAuthority),
    Proxy(authority::ProxyAuthority),
}
pub(crate) struct Write {
    pub label: String,
    authority: Authority,
    secret: Zeroizing<String>,
}
impl Write {
    pub(crate) fn host_at(
        conn: &rusqlite::Connection,
        id: &str,
        label: String,
        secret: String,
    ) -> AppResult<Self> {
        Ok(Self {
            label,
            authority: Authority::Host(authority::HostAuthority::capture(conn, id)?),
            secret: Zeroizing::new(secret),
        })
    }
    pub(crate) fn proxy_at(
        conn: &rusqlite::Connection,
        profile: &crate::network::ProxyProfile,
        secret: String,
    ) -> AppResult<Self> {
        Ok(Self {
            label: profile.name.clone(),
            authority: Authority::Proxy(authority::ProxyAuthority::capture(conn, profile)?),
            secret: Zeroizing::new(secret),
        })
    }
    pub(crate) fn save(&self, state: &AppState) -> AppResult<()> {
        self.save_with(&state.db, &state.vault, state.credentials.run)
    }
    fn save_with<P: native::Platform>(
        &self,
        db: &crate::db::Database,
        platform: &P,
        run: uuid::Uuid,
    ) -> AppResult<()> {
        let service = native::Service::new(db, platform, run)?;
        match &self.authority {
            Authority::Host(authority) => {
                let request = service.capture(
                    bindings::Owner::host(&authority.id)?,
                    || Ok(()),
                    |conn| authority.check(conn),
                )?;
                service.require_binding(&request, &authority.binding)?;
                service.save_after_admission(&request, &self.secret)
            }
            Authority::Proxy(authority) => {
                let request = service.capture(
                    bindings::Owner::proxy(&authority.profile.id)?,
                    || Ok(()),
                    |conn| authority.check(conn),
                )?;
                service.require_binding(&request, &authority.binding)?;
                service.save_after_admission(&request, &self.secret)
            }
        }
    }
}
pub(crate) fn read_host(
    state: &AppState,
    expected: &crate::models::Host,
) -> AppResult<Option<String>> {
    let authority = state.db.with(|conn| {
        let current = crate::db::hosts::find_host(conn, &expected.id)?;
        if serde_json::to_vec(&current)? != serde_json::to_vec(expected)? {
            return Err(crate::error::AppError::validation("hostTransfer.changed"));
        }
        authority::HostAuthority::capture(conn, &expected.id)
    })?;
    let service = native::Service::new(&state.db, &state.vault, state.credentials.run)?;
    let request = service.capture(
        bindings::Owner::host(&expected.id)?,
        || Ok(()),
        |conn| authority.check(conn),
    )?;
    service.require_binding(&request, &authority.binding)?;
    service.read_after_admission(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::{self, Database},
        models::{Host, HostInput},
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    #[derive(Default)]
    struct Platform {
        values: Mutex<std::collections::HashMap<String, String>>,
        fail: AtomicBool,
    }
    impl native::Platform for Platform {
        fn read(&self, item: &str) -> AppResult<Option<String>> {
            Ok(self.values.lock().unwrap().get(item).cloned())
        }
        fn write(&self, item: &str, secret: &str) -> AppResult<()> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(crate::error::AppError::validation("vault.save"));
            }
            self.values
                .lock()
                .unwrap()
                .insert(item.into(), secret.into());
            Ok(())
        }
        fn delete(&self, item: &str) -> AppResult<()> {
            self.values.lock().unwrap().remove(item);
            Ok(())
        }
    }
    fn host(db: &Database) -> Host {
        let input: HostInput = serde_json::from_value(
            serde_json::json!({"name":"Imported", "host":"example.org", "username":"user"}),
        )
        .unwrap();
        db.with(|conn| db::hosts::create_host(conn, &input.validate()?))
            .unwrap()
    }
    #[test]
    fn failed_store_can_retry_without_recreating_host_and_changed_host_is_rejected() {
        let db = Database::in_memory().unwrap();
        let host = host(&db);
        let write = db
            .with(|conn| {
                Write::host_at(conn, &host.id, host.name.clone(), "import-password".into())
            })
            .unwrap();
        let platform = Platform::default();
        let run = uuid::Uuid::new_v4();
        platform.fail.store(true, Ordering::SeqCst);
        assert!(write.save_with(&db, &platform, run).is_err());
        platform.fail.store(false, Ordering::SeqCst);
        write.save_with(&db, &platform, run).unwrap();
        assert_eq!(db.with(db::hosts::list_hosts).unwrap().len(), 1);
        assert!(platform
            .values
            .lock()
            .unwrap()
            .values()
            .any(|v| v == "import-password"));
        // A captured retry may not overwrite a credential saved by another editor.
        assert!(write.save_with(&db, &platform, run).is_err());
        let stale = db
            .with(|conn| Write::host_at(conn, &host.id, host.name.clone(), "stale-password".into()))
            .unwrap();
        db.with(|conn| {
            conn.execute(
                "UPDATE hosts SET host='different.example' WHERE id=?1",
                [&host.id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(stale.save_with(&db, &platform, run).is_err());
        assert!(!platform
            .values
            .lock()
            .unwrap()
            .values()
            .any(|v| v == "stale-password"));
    }
    #[test]
    fn imported_proxy_password_is_bound_to_remapped_profile_and_original_authority() {
        let db = Database::in_memory().unwrap();
        let profile: crate::network::ProxyProfile=serde_json::from_value(serde_json::json!({"id":"new-proxy","name":"Imported proxy","protocol":"socks5","host":"proxy.example","port":1080,"username":"proxy-user"})).unwrap();
        db.with(|conn| {
            let mut settings = db::settings::load_checked(conn)?;
            settings.network.profiles.push(profile.clone());
            db::settings::save(conn, &settings)
        })
        .unwrap();
        let write = db
            .with(|conn| Write::proxy_at(conn, &profile, "proxy-secret".into()))
            .unwrap();
        let platform = Platform::default();
        let run = uuid::Uuid::new_v4();
        write.save_with(&db, &platform, run).unwrap();
        assert!(platform
            .values
            .lock()
            .unwrap()
            .values()
            .any(|v| v == "proxy-secret"));
        let stale = db
            .with(|conn| Write::proxy_at(conn, &profile, "do-not-write".into()))
            .unwrap();
        db.with(|conn| {
            let mut settings = db::settings::load_checked(conn)?;
            settings.network.profiles[0].host = "replacement.example".into();
            db::settings::save(conn, &settings)
        })
        .unwrap();
        assert!(stale.save_with(&db, &platform, run).is_err());
    }
}
