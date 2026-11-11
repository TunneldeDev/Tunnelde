use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostListPreferences {
    pub view: String,
    pub order: Vec<String>,
    pub hidden: Vec<String>,
    pub widths: BTreeMap<String, u16>,
    pub sort: Option<Sort>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub key: String,
    pub direction: String,
}
impl Default for HostListPreferences {
    fn default() -> Self {
        Self {
            view: "tree".into(),
            order: vec![
                "name".into(),
                "address".into(),
                "user".into(),
                "port".into(),
                "group".into(),
            ],
            hidden: vec!["port".into(), "group".into()],
            widths: BTreeMap::new(),
            sort: None,
        }
    }
}
fn key(value: &str) -> bool {
    if ["name", "address", "user", "port", "group"].contains(&value) {
        return true;
    }
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 3
        && parts[0] == "plugin"
        && crate::plugins::manifest::valid_id(parts[1])
        && !parts[2].is_empty()
        && parts[2].len() <= 64
        && parts[2]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
impl HostListPreferences {
    pub fn sanitize(&mut self) {
        if self.view != "table" {
            self.view = "tree".into();
        }
        let mut seen = HashSet::new();
        self.order
            .retain(|id| id != "name" && key(id) && seen.len() < 255 && seen.insert(id.clone()));
        self.order.insert(0, "name".into());
        seen.clear();
        self.hidden
            .retain(|id| id != "name" && key(id) && seen.len() < 256 && seen.insert(id.clone()));
        let mut count = 0;
        self.widths.retain(|id, value| {
            if !key(id) || count >= 256 {
                return false;
            }
            count += 1;
            *value = (*value).clamp(64, 480);
            true
        });
        if self.sort.as_ref().is_some_and(|sort| {
            !key(&sort.key) || !["asc", "desc"].contains(&sort.direction.as_str())
        }) {
            self.sort = None;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_keep_identity_and_bound_imports_while_retaining_absent_plugins() {
        let mut value:HostListPreferences=serde_json::from_value(serde_json::json!({"view":"html","order":["address","name","address","plugin/example/cost","bad/key"],"hidden":["name","plugin/example/cost"],"widths":{"name":0,"plugin/example/cost":65000},"sort":{"key":"plugin/example/cost","direction":"asc"}})).unwrap();
        value.sanitize();
        assert_eq!(value.view, "tree");
        assert_eq!(value.order, vec!["name", "address", "plugin/example/cost"]);
        assert_eq!(value.hidden, vec!["plugin/example/cost"]);
        assert_eq!(value.widths["name"], 64);
        assert_eq!(value.widths["plugin/example/cost"], 480);
        assert!(value.sort.is_some());
        let mut default = HostListPreferences::default();
        let before = serde_json::to_value(&default).unwrap();
        default.sanitize();
        assert_eq!(serde_json::to_value(default).unwrap(), before);
    }
}
