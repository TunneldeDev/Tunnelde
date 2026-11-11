use super::super::limits;
use serde_json::json;

#[test]
fn activation_discovery_preserves_rpc_v1_and_matches_the_implemented_bounds() {
    let discovery = crate::plugins::extensions::describe();
    let activation = &discovery["runtime"]["activation"];
    assert_eq!(
        activation["manifestApiVersion"],
        crate::plugins::manifest::DEPENDENCY_API_VERSION
    );
    assert_eq!(activation["rpcApiVersion"], 1);
    assert_eq!(activation["stability"], "experimental");
    assert_eq!(activation["automaticInstallation"], false);
    assert_eq!(
        activation["limits"],
        json!({
            "catalogue":limits::MAX_CATALOGUE, "dependencies":limits::MAX_DEPENDENCIES,
            "packages":limits::MAX_PACKAGES,"edges":limits::MAX_EDGES,"depth":limits::MAX_DEPTH,
            "rangeBytes":limits::MAX_RANGE_BYTES,"requests":limits::MAX_REQUESTS,
            "blockingWorkers":limits::MAX_BLOCKING_WORKERS,"preflightTimeoutMs":limits::PREFLIGHT_TIMEOUT_MS,
        })
    );
}
