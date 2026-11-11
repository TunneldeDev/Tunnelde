use super::super::contracts::{
    handle::{Kind, Resource},
    identify::Reference,
};
use super::{connections, forwarding, mounts, tasks, transfers, unavailable, Entry, Target};
use crate::{error::AppResult, plugins::api::HostContext};

impl Target {
    fn matches_reference(&self, reference: &Reference) -> bool {
        let id = match (self, reference.kind) {
            (Self::Connection { session, .. }, Kind::Connection) => session,
            (Self::Forward { rule, .. }, Kind::Forward) => rule,
            (Self::Mount(id), Kind::Mount) | (Self::Task(id), Kind::Task) => id,
            (Self::Transfer { id, .. }, Kind::Transfer) => id,
            _ => return false,
        };
        id == &reference.id
    }
}

fn select(entries: Vec<Entry>, reference: &Reference) -> AppResult<Resource> {
    entries
        .into_iter()
        .find(|entry| entry.target.matches_reference(reference))
        .map(|entry| entry.resource)
        .ok_or_else(unavailable)
}

/// Query exactly one authoritative domain. In particular, an unrelated pending
/// mount cannot hold a known connection or process query hostage.
pub(in crate::plugins::runtime::lifecycle) async fn identify(
    context: &HostContext,
    reference: &Reference,
) -> AppResult<Resource> {
    let entries = match reference.kind {
        Kind::Connection => connections::collect(context)?,
        Kind::Forward => forwarding::collect(context)?,
        Kind::Mount => mounts::collect(context).await?,
        Kind::Task => tasks::collect(context)?,
        Kind::Transfer => transfers::collect(context)?,
    };
    select(entries, reference)
}

#[cfg(test)]
mod tests {
    use super::super::super::contracts::handle::State;
    use super::*;

    fn reference(kind: Kind, id: &str) -> Reference {
        Reference {
            kind,
            id: id.into(),
        }
    }
    fn entry(kind: Kind, handle: &str, target: Target) -> Entry {
        Entry {
            resource: Resource {
                kind,
                handle: handle.into(),
                state: State::Owned,
            },
            target,
        }
    }

    #[test]
    fn lookup_uses_public_domain_ids_and_keeps_exact_instance_handles() {
        let targets = [
            (
                Kind::Forward,
                Target::Forward {
                    rule: "rule".into(),
                    runtime: "private-instance".into(),
                },
                "rule",
            ),
            (Kind::Mount, Target::Mount("mount".into()), "mount"),
            (Kind::Task, Target::Task("task".into()), "task"),
            (
                Kind::Transfer,
                Target::Transfer {
                    id: "transfer".into(),
                    instance: "private-instance".into(),
                },
                "transfer",
            ),
        ];
        for (kind, target, id) in targets {
            assert!(target.matches_reference(&reference(kind, id)));
            assert!(!target.matches_reference(&reference(kind, "private-instance")));
            assert!(!target.matches_reference(&reference(Kind::Connection, id)));
            assert_eq!(
                select(
                    vec![entry(kind, "opaque-handle", target)],
                    &reference(kind, id)
                )
                .unwrap()
                .handle,
                "opaque-handle"
            );
        }
    }

    #[test]
    fn same_public_id_observes_the_current_instance_without_reusing_a_retired_handle() {
        let selector = reference(Kind::Forward, "rule");
        let make = |handle: &str| {
            entry(
                Kind::Forward,
                handle,
                Target::Forward {
                    rule: "rule".into(),
                    runtime: handle.into(),
                },
            )
        };
        assert_eq!(select(vec![make("old")], &selector).unwrap().handle, "old");
        assert_eq!(select(vec![make("new")], &selector).unwrap().handle, "new");
        assert!(select(vec![make("new")], &reference(Kind::Task, "rule")).is_err());
        assert!(select(Vec::new(), &selector).is_err());
    }

    #[test]
    fn connection_reference_uses_the_session_not_the_private_ownership_token() {
        use crate::plugins::{runtime::ownership::Registry, security::Lease};
        let registry = Registry::new(8, 64);
        let reserved = registry
            .reserve(
                Lease {
                    id: "plugin".into(),
                    fingerprint: "package".into(),
                    permissions: Vec::new(),
                    generation: 1,
                },
                None,
            )
            .unwrap();
        reserved.commit("session".to_string()).unwrap();
        let (receipt, session) = registry.owned("plugin", 1).pop().unwrap();
        let private = receipt.identity().to_string();
        let target = Target::Connection { session, receipt };
        assert!(target.matches_reference(&reference(Kind::Connection, "session")));
        assert!(!target.matches_reference(&reference(Kind::Connection, &private)));
        assert!(!target.matches_reference(&reference(Kind::Forward, "session")));
        assert_eq!(
            select(
                vec![entry(Kind::Connection, "opaque", target)],
                &reference(Kind::Connection, "session")
            )
            .unwrap()
            .handle,
            "opaque"
        );
    }
}
