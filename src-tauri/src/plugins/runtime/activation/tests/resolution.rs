use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::super::{contracts::Issue, graph::resolve};
use super::{names, package};

#[test]
fn dependency_free_package_has_one_step() {
    let plan = resolve("root", [package("root", &[])]).unwrap();
    assert_eq!(names(&plan), ["root"]);
    assert_eq!(plan.root, "root");
    assert!(plan.steps[0].dependencies.is_empty());
    // The parser has no AppHandle, security service, filesystem, or runtime.
    // This assertion deliberately proves graph behavior, not actual activation.
}

#[test]
fn diamond_is_deduplicated_ordered_and_independent_of_input_order() {
    let catalogue = vec![
        package("root", &[("right", "*"), ("left", "^1")]),
        package("right", &[("shared", "*")]),
        package("left", &[("shared", ">=1.0.0")]),
        package("shared", &[]),
        package("unrelated", &[]),
    ];
    let plan = resolve("root", catalogue.clone()).unwrap();
    assert_eq!(names(&plan), ["shared", "left", "right", "root"]);
    assert_eq!(plan.steps[3].dependencies[0].package.id, "left");
    assert_eq!(plan.steps[3].dependencies[0].required, "^1");
    assert_eq!(plan.steps[3].dependencies[1].package.id, "right");
    let reversed = catalogue.into_iter().rev().map(|mut item| {
        item.dependencies.reverse();
        item
    });
    assert_eq!(resolve("root", reversed).unwrap(), plan);
}

#[test]
fn errors_include_the_actual_dependency_chain() {
    assert_eq!(
        resolve("root", []),
        Err(Issue::Missing {
            id: "root".into(),
            chain: vec!["root".into()]
        })
    );
    let catalogue = [
        package("root", &[("middle", "*")]),
        package("middle", &[("missing", "*")]),
    ];
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Missing {
            id: "missing".into(),
            chain: ["root", "middle", "missing"].map(String::from).to_vec(),
        })
    );
    let catalogue = [
        package("root", &[("middle", "*")]),
        package("middle", &[("old", ">=2.0.0")]),
        package("old", &[]),
    ];
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Incompatible {
            owner: "middle".into(),
            id: "old".into(),
            required: ">=2.0.0".into(),
            installed: "1.0.0".into(),
            chain: ["root", "middle", "old"].map(String::from).to_vec(),
        })
    );
}

#[test]
fn cycles_do_not_produce_partial_plans() {
    let catalogue = [
        package("root", &[("a", "*")]),
        package("a", &[("b", "*")]),
        package("b", &[("a", "*")]),
    ];
    assert_eq!(
        resolve("root", catalogue),
        Err(Issue::Cycle {
            chain: ["root", "a", "b", "a"].map(String::from).to_vec(),
        })
    );
}

#[test]
fn unreachable_invalid_metadata_does_not_block_a_valid_root() {
    let mut unrelated = package("unrelated", &[("absent", "garbage")]);
    unrelated.identity.version = "invalid".into();
    unrelated.identity.fingerprint.clear();
    assert_eq!(
        names(&resolve("root", [unrelated, package("root", &[])]).unwrap()),
        ["root"]
    );
}

#[test]
fn all_three_node_graphs_agree_with_independent_kahn_cycle_detection() {
    let ids = ["a", "b", "c"];
    let edges: Vec<_> = ids
        .iter()
        .flat_map(|from| {
            ids.iter()
                .filter(move |to| *to != from)
                .map(move |to| (*from, *to))
        })
        .collect();
    for mask in 0..(1 << edges.len()) {
        let catalogue: Vec<_> = ids
            .iter()
            .map(|id| {
                let dependencies: Vec<_> = edges
                    .iter()
                    .enumerate()
                    .filter(|(index, (from, _))| mask & (1 << index) != 0 && from == id)
                    .map(|(_, (_, to))| (*to, "*"))
                    .collect();
                package(id, &dependencies)
            })
            .collect();
        for root in ids {
            let mut reachable = BTreeSet::from([root]);
            let mut queue = VecDeque::from([root]);
            while let Some(id) = queue.pop_front() {
                for (_, (_, dependency)) in edges
                    .iter()
                    .enumerate()
                    .filter(|(index, (from, _))| mask & (1 << index) != 0 && *from == id)
                {
                    if reachable.insert(*dependency) {
                        queue.push_back(dependency);
                    }
                }
            }
            let mut remaining = reachable.clone();
            loop {
                let leaf = remaining
                    .iter()
                    .find(|id| {
                        !edges.iter().enumerate().any(|(index, (from, to))| {
                            mask & (1 << index) != 0 && from == *id && remaining.contains(to)
                        })
                    })
                    .copied();
                if let Some(leaf) = leaf {
                    remaining.remove(leaf);
                } else {
                    break;
                }
            }
            let result = resolve(root, catalogue.clone());
            if !remaining.is_empty() {
                assert!(
                    matches!(result, Err(Issue::Cycle { .. })),
                    "mask={mask} root={root}: {result:?}"
                );
                continue;
            }
            let plan = result.unwrap();
            let positions: BTreeMap<_, _> = names(&plan)
                .into_iter()
                .enumerate()
                .map(|(index, id)| (id, index))
                .collect();
            assert_eq!(
                positions.keys().copied().collect::<BTreeSet<_>>(),
                reachable
            );
            assert_eq!(plan.steps.len(), positions.len());
            for step in &plan.steps {
                for dependency in &step.dependencies {
                    assert!(
                        positions[dependency.package.id.as_str()]
                            < positions[step.package.id.as_str()]
                    );
                }
            }
            assert_eq!(
                resolve(root, catalogue.iter().cloned().rev()).unwrap(),
                plan
            );
        }
    }
}
