//! Persisted mount state and explicit operation submission. A receipt hands
//! long-running work to the host coordinator; view closure does not own it.
use super::CallPolicy;

pub(super) fn policy(method: &str) -> Option<CallPolicy> {
    match method {
        // Audited snapshot/validation paths read existing DB or in-memory
        // state only; they never connect, touch a local mount point or drain
        // work. A staged factory may read them to render before acknowledgement.
        "mounts.rules.snapshot"
        | "mounts.rules.list"
        | "mounts.rules.get"
        | "mounts.rules.validate"
        | "mounts.rules.export"
        | "mounts.rules.importPreview"
        | "mounts.groups.list"
        | "mounts.groups.get"
        | "mounts.groups.validate"
        | "mounts.connections.list"
        | "mounts.connections.get"
        | "mounts.operations.list"
        | "mounts.operations.get" => Some(CallPolicy::StagedData),
        // Configuration writes await their bounded worker, preserving existing
        // CAS/group/permission gates. Observers may wait five seconds and are
        // committed-only: a staged view must not run a continuous polling loop.
        "mounts.rules.save"
        | "mounts.rules.move"
        | "mounts.rules.copyHost"
        | "mounts.rules.importApply"
        | "mounts.groups.save"
        | "mounts.groups.observe"
        | "mounts.connections.observe"
        | "mounts.operations.observe"
        | "mounts.operations.cancel" => Some(CallPolicy::MountData),
        // plans::call awaits preparation, then submits under the runtime's
        // existing bounded operation registry and returns an explicit receipt.
        // The worker deliberately belongs to the approved plugin generation,
        // NOT to a child view token. It checks Authority before each step.
        "mounts.groups.connect"
        | "mounts.groups.disconnect"
        | "mounts.groups.reconnect"
        | "mounts.groups.remove"
        | "mounts.rules.remove"
        | "mounts.runtime.start"
        | "mounts.runtime.startMany"
        | "mounts.runtime.startAuto"
        | "mounts.runtime.connectAndStartAuto"
        | "mounts.runtime.startAll"
        | "mounts.runtime.stop"
        | "mounts.runtime.stopMany"
        | "mounts.runtime.stopAll"
        | "mounts.runtime.restart"
        | "mounts.runtime.retry" => Some(CallPolicy::MountSubmission),
        // These can canonicalize or enumerate slow FUSE paths. Their Budget
        // workers inherit the admitted effect lifetime, including after an
        // inner timeout, caller cancellation and unreceived-result cleanup.
        "mounts.paths.local.validate" | "mounts.paths.conflicts" => Some(CallPolicy::MountPathData),
        // Windows uses the exact-origin confirmation queue; other desktops
        // retain their OS picker callback and parent window until settlement.
        "mounts.paths.local.pick" => Some(CallPolicy::OriginUi),
        "mounts.dependencies.get" | "mounts.dependencies.refresh" => {
            Some(CallPolicy::MountDependencyProbe)
        }
        // Host-only destructive consent keeps mounts.write attached to the
        // exact origin, then rechecks instance identity at transaction admission.
        // The owned worker retains group/registry gates and host stop intent
        // through actual cleanup even after cancellation or permission loss.
        "mounts.runtime.requestForceUnmount" => Some(CallPolicy::MountForceUnmount),
        // Remote paths, dependency documentation and legacy one-off transports
        // have separate native work/UI lifetimes to audit.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mount_persistence_and_receipts_are_explicit_committed_and_retained() {
        let mut data = 0;
        let mut snapshots = 0;
        let mut submissions = 0;
        let mut paths = 0;
        let mut ui = 0;
        let mut probes = 0;
        let mut force = 0;
        for method in crate::plugins::api::METHODS
            .iter()
            .filter(|m| m.name.starts_with("mounts."))
        {
            if let Some(policy) = policy(method.name) {
                assert_eq!(
                    policy.staged(),
                    policy == CallPolicy::StagedData,
                    "{}",
                    method.name
                );
                assert!(policy.retained(), "{}", method.name);
                assert!(policy.blocks_move(), "{}", method.name);
                match policy {
                    CallPolicy::MountData => data += 1,
                    CallPolicy::StagedData => snapshots += 1,
                    CallPolicy::MountSubmission => submissions += 1,
                    CallPolicy::MountPathData => paths += 1,
                    CallPolicy::OriginUi => ui += 1,
                    CallPolicy::MountDependencyProbe => probes += 1,
                    CallPolicy::MountForceUnmount => force += 1,
                    other => panic!("unexpected mount policy {other:?}"),
                }
            }
        }
        assert_eq!(data, 9);
        assert_eq!(snapshots, 13);
        assert_eq!(submissions, 15);
        assert_eq!(paths, 2);
        assert_eq!(ui, 1);
        assert_eq!(probes, 2);
        assert_eq!(force, 1);
        for method in [
            "mounts.runtime.requestForceUnmount.extra",
            "mounts.runtime.requestForceUnmount\0",
            "__mounts.forceUnmount",
            "mounts.mount",
            "mounts.unmount",
            "mounts.legacy.convert",
            "mounts.dependencies.documentation",
            "mounts.groups.connect.extra",
            "mounts.runtime.start\0",
            "mounts.rules.listAll",
        ] {
            assert!(policy(method).is_none(), "{method}");
        }
    }
}
