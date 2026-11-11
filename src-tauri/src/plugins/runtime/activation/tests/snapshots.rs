use super::super::{
    contracts::Issue,
    graph::{resolve, revalidate},
};
use super::package;

#[test]
fn same_version_replacement_and_dependency_graph_changes_expire_plans() {
    let catalogue = vec![
        package("root", &[("shared", "^1")]),
        package("shared", &[]),
        package("extra", &[]),
    ];
    let plan = resolve("root", catalogue.clone()).unwrap();
    assert_eq!(revalidate(&plan, catalogue.clone()), Ok(()));
    for index in 0..2 {
        let mut changed = catalogue.clone();
        changed[index].identity.fingerprint = "b".repeat(64);
        assert_eq!(
            revalidate(&plan, changed),
            Err(Issue::PlanChanged {
                root: "root".into()
            })
        );
    }
    let mut changed = catalogue.clone();
    changed[0].dependencies[0].version = "*".into();
    assert_eq!(
        revalidate(&plan, changed),
        Err(Issue::PlanChanged {
            root: "root".into()
        })
    );
    let mut changed = catalogue.clone();
    changed[1].dependencies = package("shared", &[("extra", "*")]).dependencies;
    assert_eq!(
        revalidate(&plan, changed),
        Err(Issue::PlanChanged {
            root: "root".into()
        })
    );
    let mut changed = catalogue.clone();
    changed[0].dependencies.clear();
    assert_eq!(
        revalidate(&plan, changed),
        Err(Issue::PlanChanged {
            root: "root".into()
        })
    );
    let mut changed = catalogue.clone();
    changed[1].identity.version = "1.1.0".into();
    assert_eq!(
        revalidate(&plan, changed),
        Err(Issue::PlanChanged {
            root: "root".into()
        })
    );
}

#[test]
fn missing_or_now_incompatible_dependencies_return_actionable_failures() {
    let catalogue = vec![package("root", &[("shared", "^1")]), package("shared", &[])];
    let plan = resolve("root", catalogue.clone()).unwrap();
    assert!(
        matches!(revalidate(&plan, [catalogue[0].clone()]), Err(Issue::Missing { id, .. }) if id == "shared")
    );
    let mut changed = catalogue;
    changed[1].identity.version = "2.0.0".into();
    assert!(
        matches!(revalidate(&plan, changed), Err(Issue::Incompatible { id, .. }) if id == "shared")
    );
}

#[test]
fn unrelated_installations_and_catalogue_order_do_not_expire_package_plans() {
    let catalogue = vec![package("root", &[("shared", "^1")]), package("shared", &[])];
    let plan = resolve("root", catalogue.clone()).unwrap();
    let mut changed = catalogue.clone();
    changed.push(package("unrelated", &[("absent", "*")]));
    assert_eq!(revalidate(&plan, changed), Ok(()));
    let mut changed = catalogue;
    changed.reverse();
    assert_eq!(revalidate(&plan, changed), Ok(()));
    // Approval, status, and live generations are not package identity. The
    // executor must obtain current leases; this plan grants no permission.
}

#[test]
fn a_modified_plan_cannot_add_omit_or_reorder_activation_steps() {
    let catalogue = vec![package("root", &[("shared", "^1")]), package("shared", &[])];
    let plan = resolve("root", catalogue.clone()).unwrap();
    let mut changed = plan.clone();
    changed.steps.reverse();
    assert!(matches!(
        revalidate(&changed, catalogue.clone()),
        Err(Issue::PlanChanged { .. })
    ));
    let mut changed = plan.clone();
    changed.steps.remove(0);
    assert!(matches!(
        revalidate(&changed, catalogue.clone()),
        Err(Issue::PlanChanged { .. })
    ));
    let mut changed = plan.clone();
    changed.steps.push(plan.steps[0].clone());
    assert!(matches!(
        revalidate(&changed, catalogue.clone()),
        Err(Issue::PlanChanged { .. })
    ));
    let mut changed = plan;
    changed.steps[1].dependencies[0].package.fingerprint = "b".repeat(64);
    assert!(matches!(
        revalidate(&changed, catalogue),
        Err(Issue::PlanChanged { .. })
    ));
}
