use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    id: String,
    group_id: Option<String>,
    name: String,
    address: String,
    port: u16,
    username: String,
    favorite: bool,
    tags: Vec<String>,
}

pub(super) fn list(db: &crate::db::Database) -> Result<Value, Failure> {
    let snapshot = crate::services::hosts::snapshot(db).map_err(|error| {
        tracing::error!(target: "automation.hosts", %error, "Cannot list saved hosts");
        Failure::new("internal", "Cannot read saved hosts; see application logs")
    })?;
    let hosts: Vec<_> = snapshot
        .hosts
        .into_iter()
        .map(|host| Host {
            id: host.id,
            group_id: host.group_id,
            name: host.name,
            address: host.host,
            port: host.port,
            username: host.username,
            favorite: host.favorite,
            tags: host.tags,
        })
        .collect();
    // Key paths, notes, credential types and private plugin metadata are omitted.
    Ok(json!({"hosts": hosts}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_host_projection_does_not_expose_private_native_fields() {
        let db = crate::db::Database::in_memory().unwrap();
        let input: crate::models::HostInput = serde_json::from_value(json!({
            "name":"QA", "host":"example.test", "username":"user", "keyPath":"/private/key", "note":"private note"
        })).unwrap();
        db.with(|conn| crate::db::hosts::create_host(conn, &input.validate()?))
            .unwrap();
        let value = list(&db).unwrap();
        let host = &value["hosts"][0];
        assert_eq!(host["address"], "example.test");
        assert_eq!(host.as_object().unwrap().len(), 8);
        assert!(host.get("keyPath").is_none() && host.get("note").is_none());
        assert!(!value.to_string().contains("/private/key"));
    }
}
