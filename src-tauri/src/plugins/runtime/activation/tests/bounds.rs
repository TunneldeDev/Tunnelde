use super::super::{
    contracts::{Issue, Limit},
    graph::resolve,
    MAX_CATALOGUE, MAX_DEPENDENCIES, MAX_DEPTH, MAX_EDGES, MAX_PACKAGES,
};
use super::{names, package};

#[test]
fn catalogue_input_is_consumed_only_to_the_limit_plus_one() {
    let consumed = std::cell::Cell::new(0);
    let catalogue = (0..).map(|index| {
        consumed.set(consumed.get() + 1);
        package(&format!("p{index}"), &[])
    });
    assert_eq!(
        resolve("p0", catalogue),
        Err(Issue::Limit {
            kind: Limit::Catalogue,
            maximum: MAX_CATALOGUE
        })
    );
    assert_eq!(consumed.get(), MAX_CATALOGUE + 1);
    assert!(resolve(
        "p0",
        (0..MAX_CATALOGUE).map(|index| package(&format!("p{index}"), &[]))
    )
    .is_ok());
}

#[test]
fn dependency_limit_is_checked_before_parsing_or_resolving() {
    let targets: Vec<_> = (0..=MAX_DEPENDENCIES)
        .map(|index| format!("p{index}"))
        .collect();
    let dependencies: Vec<_> = targets.iter().map(|id| (id.as_str(), "*")).collect();
    assert_eq!(
        resolve("root", [package("root", &dependencies)]),
        Err(Issue::Limit {
            kind: Limit::Dependencies,
            maximum: MAX_DEPENDENCIES
        })
    );
    let mut catalogue = vec![package("root", &dependencies[..MAX_DEPENDENCIES])];
    catalogue.extend(
        targets[..MAX_DEPENDENCIES]
            .iter()
            .map(|id| package(id, &[])),
    );
    assert_eq!(
        resolve("root", catalogue).unwrap().steps.len(),
        MAX_DEPENDENCIES + 1
    );
}

fn chain(length: usize) -> Vec<super::super::contracts::Package> {
    (0..length)
        .map(|index| {
            if index + 1 == length {
                package(&format!("p{index:02}"), &[])
            } else {
                package(
                    &format!("p{index:02}"),
                    &[(&format!("p{:02}", index + 1), "*")],
                )
            }
        })
        .collect()
}

#[test]
fn depth_bound_includes_already_resolved_shared_dependencies() {
    assert_eq!(
        resolve("p00", chain(MAX_DEPTH)).unwrap().steps.len(),
        MAX_DEPTH
    );
    assert_eq!(
        resolve("p00", chain(MAX_DEPTH + 1)),
        Err(Issue::Limit {
            kind: Limit::Depth,
            maximum: MAX_DEPTH
        })
    );
    // Resolve a deep chain first; a later sibling adds an edge onto that shared
    // chain without ever creating a deep recursion stack.
    let mut catalogue = chain(MAX_DEPTH - 1);
    catalogue.push(package("z", &[("p00", "*")]));
    catalogue.push(package("root", &[("p00", "*"), ("z", "*")]));
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Limit {
            kind: Limit::Depth,
            maximum: MAX_DEPTH
        })
    );
}

#[test]
fn unique_package_limit_does_not_count_shared_visits() {
    let at_limit_leaves = MAX_PACKAGES - 5;
    let at_limit_ids: Vec<_> = (0..at_limit_leaves)
        .map(|index| format!("leaf{index:02}"))
        .collect();
    let mut at_limit = Vec::new();
    let mut at_limit_groups = Vec::new();
    for (index, chunk) in at_limit_ids.chunks(MAX_DEPENDENCIES).enumerate() {
        let group = format!("group{index}");
        at_limit.push(package(
            &group,
            &chunk
                .iter()
                .map(|id| (id.as_str(), "*"))
                .collect::<Vec<_>>(),
        ));
        at_limit_groups.push(group);
    }
    assert_eq!(at_limit_groups.len(), 4);
    at_limit.push(package(
        "root",
        &at_limit_groups
            .iter()
            .map(|id| (id.as_str(), "*"))
            .collect::<Vec<_>>(),
    ));
    at_limit.extend(at_limit_ids.iter().map(|id| package(id, &[])));
    assert_eq!(resolve("root", at_limit).unwrap().steps.len(), MAX_PACKAGES);
    let leaves: Vec<_> = (0..MAX_PACKAGES)
        .map(|index| format!("leaf{index:02}"))
        .collect();
    let mut catalogue = Vec::new();
    let mut groups = Vec::new();
    for (index, chunk) in leaves.chunks(MAX_DEPENDENCIES).enumerate() {
        let id = format!("group{index}");
        let dependencies: Vec<_> = chunk.iter().map(|id| (id.as_str(), "*")).collect();
        catalogue.push(package(&id, &dependencies));
        groups.push(id);
    }
    let dependencies: Vec<_> = groups.iter().map(|id| (id.as_str(), "*")).collect();
    catalogue.push(package("root", &dependencies));
    catalogue.extend(leaves.iter().map(|id| package(id, &[])));
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Limit {
            kind: Limit::Packages,
            maximum: MAX_PACKAGES
        })
    );
    let shared: Vec<_> = (0..MAX_DEPENDENCIES)
        .map(|index| format!("shared{index:02}"))
        .collect();
    let dependencies: Vec<_> = shared.iter().map(|id| (id.as_str(), "*")).collect();
    let mut catalogue = vec![
        package("root", &[("left", "*"), ("right", "*")]),
        package("left", &dependencies),
        package("right", &dependencies),
    ];
    catalogue.extend(shared.iter().map(|id| package(id, &[])));
    assert_eq!(
        names(&resolve("root", catalogue).unwrap()).len(),
        MAX_DEPENDENCIES + 3
    );
}

#[test]
fn edge_limit_counts_distinct_declared_edges_even_when_nodes_are_shared() {
    let shared: Vec<_> = (0..MAX_DEPENDENCIES)
        .map(|index| format!("shared{index:02}"))
        .collect();
    let groups: Vec<_> = (0..MAX_DEPENDENCIES)
        .map(|index| format!("group{index:02}"))
        .collect();
    let mut catalogue = vec![package(
        "root",
        &groups
            .iter()
            .map(|id| (id.as_str(), "*"))
            .collect::<Vec<_>>(),
    )];
    for group in &groups {
        catalogue.push(package(
            group,
            &shared
                .iter()
                .map(|id| (id.as_str(), "*"))
                .collect::<Vec<_>>(),
        ));
    }
    catalogue.extend(shared.iter().map(|id| package(id, &[])));
    // The root has sixteen edges; fifteen groups each add sixteen, reaching
    // exactly 256. One more shared edge must cross the limit.
    let mut at_limit = catalogue.clone();
    at_limit[MAX_DEPENDENCIES].dependencies.clear();
    assert_eq!(
        resolve("root", at_limit.clone())
            .unwrap()
            .steps
            .iter()
            .map(|step| step.dependencies.len())
            .sum::<usize>(),
        MAX_EDGES
    );
    at_limit[MAX_DEPENDENCIES].dependencies = package("unused", &[("shared00", "*")]).dependencies;
    assert_eq!(
        resolve("root", at_limit),
        Err(Issue::Limit {
            kind: Limit::Edges,
            maximum: MAX_EDGES
        })
    );
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Limit {
            kind: Limit::Edges,
            maximum: MAX_EDGES
        })
    );
}
