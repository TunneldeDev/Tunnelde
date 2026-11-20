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
    MountData,
    /// Fenced through receipt publication; the host owns subsequent steps.
    MountSubmission,
}
impl CallPolicy {
    pub(crate) fn staged(self) -> bool {
        self == Self::Metadata
    }
    pub(crate) fn blocks_move(self) -> bool {
        self != Self::BusReceive
    }
    pub(crate) fn retained(self) -> bool {
        self != Self::BusReceive
    }
}
pub(crate) fn call_policy(method: &str) -> Option<CallPolicy> {
    match method {
        "api.describe" | "extensions.describe" => Some(CallPolicy::Metadata),
        "bus.advertise" | "bus.discover" | "bus.snapshot" | "bus.decline" | "bus.create"
        | "bus.invite" | "bus.invitations" | "bus.join" | "bus.leave" | "bus.close"
        | "bus.subscribe" | "bus.unsubscribe" | "bus.publish" => Some(CallPolicy::BusEffect),
        // An async Notify wait has no detached worker. Cancellation drops its
        // receiver permit; each eventual queue drain rechecks native ownership.
        "bus.receive" => Some(CallPolicy::BusReceive),
        "ui.confirm" | "ui.showMessage" => Some(CallPolicy::OriginUi),
        // KV uses awaited tokio::fs operations under its serialization lock.
        // Configuration awaits the blocking worker (no nested timeout/early
        // reply); keyring access awaits the bounded credential worker. None
        // requires a main-window UI relay or owns a background provider handle.
        // Even reads remain committed-only: names never establish staging safety.
        "storage.get"
        | "storage.set"
        | "storage.delete"
        | "storage.observe"
        | "configuration.schema"
        | "configuration.snapshot"
        | "configuration.update"
        | "configuration.migrate"
        | "configuration.backups"
        | "configuration.restore"
        | "configuration.deleteBackup"
        | "secrets.get"
        | "secrets.set"
        | "secrets.delete" => Some(CallPolicy::OwnedData),
        _ => mounts::policy(method),
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
    fn owned_data_methods_have_explicit_committed_retained_lifetimes() {
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
            assert_eq!(policy, CallPolicy::OwnedData);
            assert!(!policy.staged(), "{method}");
            assert!(policy.blocks_move(), "{method}");
            assert!(policy.retained(), "{method}");
        }
        // Consent/migration control and future APIs require separate audits;
        // no prefix, permission, or get/observe heuristic widens admission.
        for method in [
            "storage.locations.schedule",
            "storage.locations.observe",
            "storage.recovery.request",
            "storage.recovery.observe",
            "storage.get.extra",
            "configuration.observe",
            "configuration.update.extra",
            "secrets.getOther",
            "secrets.get\0",
            "settings.get",
        ] {
            assert!(call_policy(method).is_none(), "{method}");
        }
    }
}
