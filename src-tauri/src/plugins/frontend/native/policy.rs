//! Reviewed native-view call lifetimes. Names/permissions alone never establish
//! staging safety or whether dropping a future really cancels native work.
mod mounts;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallPolicy {
    Metadata,
    BusEffect,
    BusReceive,
    OriginUi,
    /// Owned persistent data; all nested I/O is awaited through settlement.
    OwnedData,
    /// Explicitly audited snapshot-only queries needed before staged render.
    StagedData,
    MountData,
    /// Filesystem queries retain the fence through timed-out FUSE workers.
    MountPathData,
    /// OS dependency probes retain their worker through process kill and reap.
    MountDependencyProbe,
    /// Owned SFTP channel/readers retain the original connection and effect until CLOSE.
    MountRemotePath,
    /// Owned legacy conversion/metadata workers retain origin and actual effect.
    MountLegacy,
    /// Registry/group reservations survive nested FS timeouts and OS launch.
    MountOpen,
    /// One-off startup retains original session/admission through lost-result cleanup.
    MountCreation,
    /// One-off plugin-owned teardown retains registry/probes/process reaping.
    MountUnmount,
    /// Fixed host documentation URL with original read-grant launch admission.
    MountDocumentation,
    /// Exact-origin destructive consent followed by an owned force-stop transaction.
    MountForceUnmount,
    /// Fenced through receipt publication; the host owns subsequent steps.
    MountSubmission,
}
impl CallPolicy {
    pub(crate) fn staged(self) -> bool {
        matches!(self, Self::Metadata | Self::StagedData)
    }
    pub(crate) fn blocks_move(self) -> bool {
        self != Self::BusReceive
    }
    pub(crate) fn retained(self) -> bool {
        self != Self::BusReceive
    }
}
pub(crate) fn call_policy(method: &str) -> Option<CallPolicy> {
    policy(method)
}

/// Exact method classes are shared by native admission and coordinator reply
/// revalidation. Prefixes and permissions never widen this closed list.
fn policy(method: &str) -> Option<CallPolicy> {
    match method {
        "api.describe" | "extensions.describe" => Some(CallPolicy::Metadata),
        "bus.advertise" | "bus.discover" | "bus.snapshot" | "bus.decline" | "bus.create"
        | "bus.invite" | "bus.invitations" | "bus.join" | "bus.leave" | "bus.close"
        | "bus.subscribe" | "bus.unsubscribe" | "bus.publish" => Some(CallPolicy::BusEffect),
        // An async Notify wait has no detached worker. Cancellation drops its
        // receiver permit; each eventual queue drain rechecks native ownership.
        "bus.receive" => Some(CallPolicy::BusReceive),
        "ui.confirm" | "ui.showMessage" => Some(CallPolicy::OriginUi),
        // Explicit pure snapshots, not a get/list naming heuristic. KV reads
        // never create directories/files; configuration uses read-only SQLite
        // connections and never migrates, writes defaults or consumes a queue.
        // Staged factories need these to restore before render acknowledgement.
        // Host metadata readers are explicitly audited: saved snapshots use
        // retained bounded DB workers, routes/fields use authorized retained
        // admission workers, and discovery snapshots only clone in-memory data.
        // No default writes, migrations, credentials, SSH or OS prompts.
        "app.info"
        | "settings.get"
        | "history.list"
        | "forwards.list"
        | "forwards.groups.list"
        | "forwards.automation.list"
        | "tasks.list"
        | "tasks.status"
        | "tasks.readOutput"
        | "profiles.catalogue"
        | "profiles.observe"
        | "profiles.read"
        | "hosts.transfer.export"
        | "hosts.transfer.preview"
        | "storage.locations.observe"
        | "storage.recovery.observe"
        | "hosts.snapshot"
        | "hosts.sourcesSnapshot"
        | "hosts.routes.get"
        | "hosts.routes.observe"
        | "hosts.getFields"
        | "storage.get"
        | "storage.observe"
        | "preferences.schema"
        | "preferences.snapshot"
        | "preferences.observe"
        | "configuration.schema"
        | "configuration.snapshot"
        | "configuration.backups"
        | "sessions.list"
        | "files.local.home"
        | "files.transferStatus"
        | "resources.snapshot"
        | "workspace.snapshot"
        | "workspace.panels.list"
        | "workspace.panels.observe"
        | "workspace.panels.ownership"
        | "workspace.windows.list"
        | "workspace.windows.observe"
        | "editor.active"
        | "editor.observe"
        | "editor.readRange"
        | "fileBrowser.observe"
        | "fileBrowser.read"
        | "filePreview.observe"
        | "filePreview.providers" => Some(CallPolicy::StagedData),
        // Mutations await actual I/O; even keyring reads can prompt/perform OS
        // work, so they are NOT admitted during staging.
        "hosts.routes.save"
        | "hosts.setFields"
        | "hosts.create"
        | "hosts.update"
        | "hosts.delete"
        | "hosts.markUsed"
        | "hosts.reorder"
        | "groups.create"
        | "groups.update"
        | "groups.delete"
        | "files.local.writeText"
        | "files.local.createFile"
        | "files.local.mkdir"
        | "files.local.rename"
        | "files.local.delete"
        | "files.local.copy"
        | "files.sftp.writeText"
        | "files.sftp.createFile"
        | "files.sftp.mkdir"
        | "files.sftp.rename"
        | "files.sftp.delete"
        | "files.sftp.copy"
        | "files.upload"
        | "files.download"
        | "files.cancelTransfer"
        | "files.local.list"
        | "files.local.readText"
        | "files.sftp.list"
        | "files.sftp.resolveDirectory"
        | "files.sftp.readText"
        | "sessions.connect"
        | "sessions.disconnect"
        | "sessions.requestHandoff"
        | "sessions.exec"
        | "terminal.write"
        | "terminal.resize"
        | "editor.applyEdits"
        | "editor.replace"
        | "fileBrowser.action"
        | "filePreview.action"
        | "filePreview.open"
        | "workspace.panels.setPresentation"
        | "workspace.panels.close"
        | "workspace.panels.moveToWindow"
        | "workspace.windows.create"
        | "workspace.windows.close" => Some(CallPolicy::OwnedData),
        "app.openExternal"
        | "clipboard.readText"
        | "clipboard.writeText"
        | "monitor.system"
        | "monitor.stats"
        | "monitor.processes"
        | "history.record"
        | "history.delete"
        | "history.clear"
        | "forwards.save"
        | "forwards.remove"
        | "forwards.automation.save"
        | "forwards.groups.save"
        | "forwards.groups.remove"
        | "forwards.move"
        | "statusBar.set"
        | "statusBar.remove"
        | "tabBar.set"
        | "tabBar.remove"
        | "hostList.setColumn"
        | "hostList.removeColumn"
        | "hostList.setDecorations"
        | "hostList.removeDecorations"
        | "fileList.setHighlights"
        | "fileList.removeHighlights"
        | "hosts.setSource"
        | "hosts.removeSource"
        | "hosts.sshConfig.preview"
        | "hosts.sshConfig.import"
        | "hosts.transfer.apply"
        | "settings.update"
        | "preferences.update"
        | "storage.set"
        | "storage.delete"
        | "configuration.update"
        | "configuration.migrate"
        | "configuration.restore"
        | "configuration.deleteBackup"
        | "secrets.get"
        | "secrets.set"
        | "secrets.delete" => Some(CallPolicy::OwnedData),
        _ => mounts::policy(method),
    }
}
#[cfg(test)]
mod workspace_and_file_tests {
    use super::*;
    #[test]
    fn reviewed_workspace_and_file_methods_have_closed_native_lifetimes() {
        for method in [
            "sessions.list",
            "files.local.home",
            "files.transferStatus",
            "resources.snapshot",
            "workspace.snapshot",
            "workspace.panels.list",
            "workspace.panels.observe",
            "workspace.panels.ownership",
            "workspace.windows.list",
            "workspace.windows.observe",
            "editor.active",
            "editor.observe",
            "editor.readRange",
            "fileBrowser.observe",
            "fileBrowser.read",
            "filePreview.observe",
            "filePreview.providers",
            "app.info",
            "settings.get",
            "history.list",
            "forwards.list",
            "forwards.groups.list",
            "forwards.automation.list",
            "tasks.list",
            "tasks.status",
            "tasks.readOutput",
            "profiles.catalogue",
            "profiles.observe",
            "profiles.read",
            "hosts.transfer.export",
            "hosts.transfer.preview",
            "storage.locations.observe",
            "storage.recovery.observe",
        ] {
            assert!(
                crate::plugins::api::method_info(method).is_some(),
                "{method}"
            );
            let policy = call_policy(method).unwrap();
            assert_eq!(policy, CallPolicy::StagedData, "{method}");
            assert!(policy.staged() && policy.retained() && policy.blocks_move());
        }
        for method in [
            "files.local.list",
            "files.local.readText",
            "files.sftp.list",
            "files.sftp.resolveDirectory",
            "files.sftp.readText",
            "files.local.writeText",
            "files.local.createFile",
            "files.local.mkdir",
            "files.local.rename",
            "files.local.delete",
            "files.local.copy",
            "files.sftp.writeText",
            "files.sftp.createFile",
            "files.sftp.mkdir",
            "files.sftp.rename",
            "files.sftp.delete",
            "files.sftp.copy",
            "files.upload",
            "files.download",
            "files.cancelTransfer",
            "sessions.connect",
            "sessions.disconnect",
            "sessions.requestHandoff",
            "sessions.exec",
            "terminal.write",
            "terminal.resize",
            "editor.applyEdits",
            "editor.replace",
            "fileBrowser.action",
            "filePreview.action",
            "filePreview.open",
            "workspace.panels.setPresentation",
            "workspace.panels.close",
            "workspace.panels.moveToWindow",
            "workspace.windows.create",
            "workspace.windows.close",
            "app.openExternal",
            "clipboard.readText",
            "clipboard.writeText",
            "monitor.system",
            "monitor.stats",
            "monitor.processes",
            "history.record",
            "history.delete",
            "history.clear",
            "forwards.save",
            "forwards.remove",
            "forwards.automation.save",
            "forwards.groups.save",
            "forwards.groups.remove",
            "forwards.move",
            "statusBar.set",
            "statusBar.remove",
            "tabBar.set",
            "tabBar.remove",
            "hostList.setColumn",
            "hostList.removeColumn",
            "hostList.setDecorations",
            "hostList.removeDecorations",
            "fileList.setHighlights",
            "fileList.removeHighlights",
            "hosts.setSource",
            "hosts.removeSource",
            "hosts.sshConfig.preview",
            "hosts.sshConfig.import",
            "hosts.transfer.apply",
            "settings.update",
        ] {
            assert!(
                crate::plugins::api::method_info(method).is_some(),
                "{method}"
            );
            let policy = call_policy(method).unwrap();
            assert_eq!(policy, CallPolicy::OwnedData, "{method}");
            assert!(!policy.staged() && policy.retained() && policy.blocks_move());
        }
        for method in [
            "files.content.open",
            "files.content.read",
            "files.content.close",
            "files.content.observe",
            "workspace.openPage",
            "workspace.windows.unknown",
            "sessions.connect.extra",
            "monitor.kill",
        ] {
            assert!(call_policy(method).is_none(), "{method}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_ui_requires_committed_ownership_and_retains_until_settlement() {
        for method in ["ui.confirm", "ui.showMessage"] {
            let policy = call_policy(method).unwrap();
            assert_eq!(policy, CallPolicy::OriginUi);
            assert!(!policy.staged());
            assert!(policy.blocks_move());
            assert!(policy.retained());
        }
        for method in ["ui.confirm.extra", "ui.prompt", "ui.openDialog"] {
            assert!(call_policy(method).is_none());
        }
    }

    #[test]
    fn all_existing_bus_methods_have_explicit_committed_only_lifetimes() {
        let methods: Vec<_> = crate::plugins::api::METHODS
            .iter()
            .filter(|m| m.name.starts_with("bus."))
            .collect();
        assert_eq!(methods.len(), 14);
        for method in methods {
            let policy = call_policy(method.name).unwrap();
            assert!(!policy.staged(), "{}", method.name);
            assert_eq!(policy.retained(), method.name != "bus.receive");
            assert_eq!(policy.blocks_move(), method.name != "bus.receive");
        }
        for method in [
            "bus.observe",
            "bus.receive.extra",
            "bus.publish\0",
            "bus.get",
        ] {
            assert!(call_policy(method).is_none(), "{method}");
        }
    }
}

#[cfg(test)]
mod owned_data_tests {
    use super::*;
    #[test]
    fn owned_data_methods_have_explicit_reviewed_retained_lifetimes() {
        let methods = [
            "storage.get",
            "storage.set",
            "storage.delete",
            "storage.observe",
            "configuration.schema",
            "configuration.snapshot",
            "configuration.update",
            "configuration.migrate",
            "configuration.backups",
            "configuration.restore",
            "configuration.deleteBackup",
            "secrets.get",
            "secrets.set",
            "secrets.delete",
        ];
        assert_eq!(methods.len(), 14);
        for method in methods {
            assert!(
                crate::plugins::api::method_info(method).is_some(),
                "{method}"
            );
            let policy = call_policy(method).unwrap();
            let snapshot = matches!(
                method,
                "storage.get"
                    | "storage.observe"
                    | "configuration.schema"
                    | "configuration.snapshot"
                    | "configuration.backups"
            );
            assert_eq!(
                policy,
                if snapshot {
                    CallPolicy::StagedData
                } else {
                    CallPolicy::OwnedData
                }
            );
            assert_eq!(policy.staged(), snapshot, "{method}");
            assert!(policy.blocks_move(), "{method}");
            assert!(policy.retained(), "{method}");
        }
        // Consent/migration control and future APIs require separate audits;
        // no prefix, permission, or get/observe heuristic widens admission.
        for method in [
            "storage.locations.schedule",
            "storage.recovery.request",
            "storage.get.extra",
            "configuration.observe",
            "configuration.update.extra",
            "secrets.getOther",
            "secrets.get\0",
        ] {
            assert!(call_policy(method).is_none(), "{method}");
        }
    }
}

#[cfg(test)]
mod host_metadata_tests {
    use super::*;
    #[test]
    fn only_reviewed_host_metadata_readers_are_staging_safe_and_retained() {
        for method in [
            "hosts.snapshot",
            "hosts.sourcesSnapshot",
            "hosts.routes.get",
            "hosts.routes.observe",
            "hosts.getFields",
        ] {
            assert!(
                crate::plugins::api::method_info(method).is_some(),
                "{method}"
            );
            let policy = call_policy(method).unwrap();
            assert_eq!(policy, CallPolicy::StagedData, "{method}");
            assert!(
                policy.staged() && policy.retained() && policy.blocks_move(),
                "{method}"
            );
        }
        for method in [
            "hosts.snapshot.extra",
            "hosts.snapshot\0",
            "hosts.sshConfig.unknown",
            "hostList.unknown",
        ] {
            assert!(call_policy(method).is_none(), "{method}");
        }
    }
}

#[cfg(test)]
mod preferences_tests {
    use super::*;
    #[test]
    fn preferences_reads_are_staging_safe_but_writes_require_owned_retained_effects() {
        for method in [
            "preferences.schema",
            "preferences.snapshot",
            "preferences.observe",
        ] {
            assert!(crate::plugins::api::method_info(method).is_some());
            assert_eq!(call_policy(method), Some(CallPolicy::StagedData));
        }
        let write = call_policy("preferences.update").unwrap();
        assert!(!write.staged() && write.retained() && write.blocks_move());
        for method in ["preferences.snapshot.extra", "preferences.import"] {
            assert!(call_policy(method).is_none());
        }
    }
}

#[cfg(test)]
mod host_write_tests {
    use super::*;
    #[test]
    fn only_audited_host_writes_are_committed_and_retained() {
        for method in [
            "hosts.routes.save",
            "hosts.setFields",
            "hosts.create",
            "hosts.update",
            "hosts.delete",
            "hosts.markUsed",
            "hosts.reorder",
            "groups.create",
            "groups.update",
            "groups.delete",
        ] {
            assert!(crate::plugins::api::method_info(method).is_some());
            let policy = call_policy(method).unwrap();
            assert_eq!(policy, CallPolicy::OwnedData);
            assert!(!policy.staged());
            assert!(policy.retained() && policy.blocks_move());
        }
        for method in ["hosts.routes.save.extra", "hosts.setFields\0"] {
            assert!(call_policy(method).is_none());
        }
    }
}
