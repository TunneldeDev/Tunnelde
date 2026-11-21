//! Closed native host-list UI grammar. The coordinator resolves incarnation
//! markers against its current projection; callers cannot submit raw hosts,
//! credentials, settings patches or arbitrary application command names.
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostTarget {
    id: String,
    revision: String,
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl HostTarget {
    fn valid(&self) -> bool {
        bounded(&self.id, 1024) && uuid::Uuid::parse_str(&self.revision).is_ok()
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HostCommand {
    Activate {
        host: HostTarget,
    },
    Connect {
        host: HostTarget,
    },
    Open {
        host: HostTarget,
    },
    Edit {
        host: HostTarget,
    },
    Delete {
        host: HostTarget,
    },
    Favorite {
        host: HostTarget,
    },
    Duplicate {
        host: HostTarget,
    },
    SaveCopy {
        host: HostTarget,
    },
    Export {
        host: HostTarget,
    },
    CopySsh {
        host: HostTarget,
    },
    CopyAddress {
        host: HostTarget,
    },
    Sftp {
        host: HostTarget,
    },
    InstallKey {
        host: HostTarget,
    },
    Move {
        host: HostTarget,
        target: HostTarget,
        position: Position,
    },
    MoveToGroup {
        host: HostTarget,
        group: Option<HostTarget>,
        favorite: bool,
    },
    NewHost {
        group: Option<HostTarget>,
    },
    NewGroup {},
    ImportSsh {},
    Import {},
    ExportAll {},
    EditGroup {
        group: HostTarget,
    },
    DeleteGroup {
        group: HostTarget,
    },
    Plugin {
        host: HostTarget,
        plugin_id: String,
        command: String,
        fingerprint: Option<String>,
    },
    View {
        view: View,
    },
    Column {
        key: String,
        command: Column,
    },
    ResizeColumn {
        key: String,
        width: u16,
    },
    MoveColumn {
        from: String,
        to: String,
    },
    ResetColumns {},
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Position {
    Before,
    After,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum View {
    Tree,
    Table,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Column {
    Toggle,
    Sort,
}
impl HostCommand {
    pub(super) fn detail_host(&self) -> Option<&str> {
        match self {
            Self::Connect { host }
            | Self::Sftp { host }
            | Self::Favorite { host }
            | Self::Edit { host }
            | Self::Delete { host }
            | Self::Duplicate { host } => Some(&host.id),
            _ => None,
        }
    }

    pub(super) fn valid(&self) -> bool {
        match self {
            Self::Activate { host }
            | Self::Connect { host }
            | Self::Open { host }
            | Self::Edit { host }
            | Self::Delete { host }
            | Self::Favorite { host }
            | Self::Duplicate { host }
            | Self::SaveCopy { host }
            | Self::Export { host }
            | Self::CopySsh { host }
            | Self::CopyAddress { host }
            | Self::Sftp { host }
            | Self::InstallKey { host } => host.valid(),
            Self::Move { host, target, .. } => {
                host.valid() && target.valid() && host.id != target.id
            }
            Self::MoveToGroup { host, group, .. } => {
                host.valid() && group.as_ref().is_none_or(HostTarget::valid)
            }
            Self::NewHost { group } => group.as_ref().is_none_or(HostTarget::valid),
            Self::EditGroup { group } | Self::DeleteGroup { group } => group.valid(),
            Self::Plugin {
                host,
                plugin_id,
                command,
                fingerprint,
            } => {
                host.valid()
                    && bounded(plugin_id, 128)
                    && bounded(command, 256)
                    && fingerprint.as_ref().is_none_or(|f| bounded(f, 128))
            }
            Self::Column { key, .. } => bounded(key, 512),
            Self::ResizeColumn { key, width } => bounded(key, 512) && (64..=480).contains(width),
            Self::MoveColumn { from, to } => bounded(from, 512) && bounded(to, 512),
            _ => true,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn target() -> Value {
        json!({"id":"host","revision":uuid::Uuid::new_v4().to_string()})
    }
    #[test]
    fn host_commands_are_closed_bounded_and_incarnation_qualified() {
        for operation in [
            "activate",
            "connect",
            "open",
            "edit",
            "delete",
            "favorite",
            "saveCopy",
            "export",
            "copySsh",
            "copyAddress",
            "sftp",
            "installKey",
        ] {
            let good = json!({"operation":operation,"host":target()});
            assert!(serde_json::from_value::<HostCommand>(good.clone())
                .unwrap()
                .valid());
            let mut bad = good.clone();
            bad["host"]["password"] = json!("secret");
            assert!(serde_json::from_value::<HostCommand>(bad).is_err());
            let mut bad = good.clone();
            bad["host"]["revision"] = json!("old");
            assert!(!serde_json::from_value::<HostCommand>(bad).unwrap().valid());
            let mut bad = good;
            bad["host"]["id"] = json!("x".repeat(1025));
            assert!(!serde_json::from_value::<HostCommand>(bad).unwrap().valid());
        }
        for operation in [
            "newGroup",
            "importSsh",
            "import",
            "exportAll",
            "resetColumns",
        ] {
            assert!(
                serde_json::from_value::<HostCommand>(json!({"operation":operation}))
                    .unwrap()
                    .valid()
            );
            assert!(serde_json::from_value::<HostCommand>(
                json!({"operation":operation,"command":"ssh_connect"})
            )
            .is_err());
        }
        for value in [
            json!({"operation":"view","view":"hacked"}),
            json!({"operation":"column","key":"name","command":"updateSettings"}),
            json!({"operation":"resizeColumn","key":"name","width":4800}),
        ] {
            assert!(serde_json::from_value::<HostCommand>(value).map_or(true, |v| !v.valid()));
        }
    }
}
