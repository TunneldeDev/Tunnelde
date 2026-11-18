use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub host_id: String,
    pub name: String,
    #[serde(default)]
    pub auto_reconnect: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub host_id: String,
    pub group_id: String,
    pub name: String,
    pub remote_path: String,
    pub mount_point: String,
    #[serde(default = "read_only")]
    pub read_only: bool,
    #[serde(default)]
    pub auto_mount: bool,
}
fn read_only() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry<T> {
    pub revision: String,
    pub value: T,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Save<T> {
    pub value: T,
    /// Omitted only when creating an ID that does not already exist.
    pub expected_revision: Option<String>,
}

pub(super) fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
pub fn validate_group(group: &Group) -> AppResult<()> {
    if !id(&group.id) || !id(&group.host_id) || !text(&group.name, 120) {
        return Err(AppError::validation("mounts.rules.invalid"));
    }
    Ok(())
}
pub fn validate_rule(rule: &Rule) -> AppResult<()> {
    if !id(&rule.id)
        || !id(&rule.host_id)
        || !id(&rule.group_id)
        || !text(&rule.name, 120)
        || !text(&rule.remote_path, 2048)
        || !rule.remote_path.starts_with('/')
        || rule
            .remote_path
            .split('/')
            .any(|part| matches!(part, "." | ".."))
        || !text(&rule.mount_point, 2048)
    {
        return Err(AppError::validation("mounts.rules.invalid"));
    }
    validate_local_path(&rule.mount_point)
}

pub fn validate_local_path(path: &str) -> AppResult<()> {
    if !text(path, 2048)
        || !std::path::Path::new(path).is_absolute()
        || std::path::Path::new(path).components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(AppError::validation("mounts.mountPoint.absoluteRequired"));
    }
    if cfg!(windows) {
        let bytes = path.as_bytes();
        if bytes.len() != 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'/' | b'\\')
        {
            return Err(AppError::validation(
                "mounts.mountPoint.unusedDriveRequired",
            ));
        }
    } else if path == "/" {
        return Err(AppError::validation(
            "mounts.mountPoint.emptyDirectoryRequired",
        ));
    }
    Ok(())
}
