use super::*;
#[test]
fn discovery_matches_implemented_limits_and_keeps_lifecycle_methods_experimental_and_owned() {
    let directory = crate::plugins::extensions::describe();
    let lifecycle = &directory["runtime"]["resources"];
    assert_eq!(lifecycle["ownership"], "current-runtime");
    assert_eq!(lifecycle["pageSize"], PAGE_SIZE);
    assert_eq!(lifecycle["pageBytes"], PAGE_BYTES);
    assert_eq!(lifecycle["observationLimit"], MAX_ITEMS);
    assert_eq!(lifecycle["operationLimitPerPlugin"], 4);
    assert_eq!(lifecycle["operationLimitTotal"], 16);
    assert_eq!(lifecycle["observationTimeoutMs"], 5000);
    assert_eq!(
        lifecycle["kinds"],
        serde_json::json!(["connection", "forward", "mount", "task", "transfer"])
    );
    assert_eq!(
        lifecycle["states"],
        serde_json::json!(["owned", "releaseRequested", "cleanupRequired"])
    );
    for action in ["snapshot", "release"] {
        let name = lifecycle[action].as_str().unwrap();
        let method = crate::plugins::api::method_info(name).unwrap();
        assert!(method.permissions.is_empty());
        assert_eq!(method.stability, "experimental");
    }
}
