use super::*;
use crate::plugins::runtime::lifecycle::contracts::{
    handle::{Kind, State},
    release::Request,
};
fn entries(count: usize) -> Vec<Resource> {
    (0..count)
        .map(|i| Resource {
            handle: format!("{i:064x}"),
            kind: Kind::Task,
            state: State::Owned,
        })
        .collect()
}
#[test]
fn pages_are_bounded_and_cannot_mix_observations_or_silently_ignore_fields() {
    let first = page(entries(129), Query::default()).unwrap();
    assert_eq!(first.items.len(), 128);
    assert_eq!(first.total, 129);
    assert_eq!(first.next_offset, Some(128));
    let last = page(
        entries(129),
        Query {
            offset: 128,
            revision: Some(first.revision.clone()),
        },
    )
    .unwrap();
    assert_eq!(last.items.len(), 1);
    assert_eq!(last.next_offset, None);
    assert!(page(
        entries(129),
        Query {
            offset: 128,
            revision: None
        }
    )
    .is_err());
    assert!(page(
        entries(129),
        Query {
            offset: 130,
            revision: None
        }
    )
    .is_err());
    let mut changed = entries(129);
    changed[0].state = State::ReleaseRequested;
    assert!(page(
        changed,
        Query {
            offset: 128,
            revision: Some(first.revision.clone())
        }
    )
    .unwrap_err()
    .to_string()
    .contains("changed"));
    assert!(page(
        entries(128),
        Query {
            offset: 0,
            revision: Some(first.revision)
        }
    )
    .is_err());
    assert!(page(entries(MAX_ITEMS + 1), Query::default()).is_err());
    for params in [
        serde_json::json!({"offset":-1}),
        serde_json::json!({"offset":1.1}),
        serde_json::json!({"pluginId":"other"}),
        serde_json::json!({"offset":null}),
    ] {
        assert!(serde_json::from_value::<Query>(params).is_err());
    }
    assert!(
        serde_json::from_value::<Request>(serde_json::json!({"handle":"x","generation":1}))
            .is_err()
    );
}
#[test]
fn empty_and_maximal_pages_respect_the_wire_budget() {
    let empty = page(vec![], Query::default()).unwrap();
    assert_eq!(empty.total, 0);
    assert_eq!(empty.next_offset, None);
    let full = page(entries(MAX_ITEMS), Query::default()).unwrap();
    assert_eq!(full.total, MAX_ITEMS);
    assert!(serde_json::to_vec(&full).unwrap().len() <= PAGE_BYTES);
}
