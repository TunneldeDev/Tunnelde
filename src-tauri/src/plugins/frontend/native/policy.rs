//! Reviewed native-view call lifetimes. Names/permissions alone never establish
//! staging safety or whether dropping a future really cancels native work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallPolicy {
    Metadata,
    BusEffect,
    BusReceive,
    OriginUi,
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
        _ => None,
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
