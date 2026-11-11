use super::*;

#[test]
fn shared_runtime_graph_enforces_exact_edge_budget_without_double_counting_nodes() {
    for extra in [false, true] {
        let (security, db) = fixture();
        let mut leaves = Vec::new();
        for index in 0..16 {
            let lease = grant(&security, &db, &format!("leaf-{index}"), &[]);
            ready(&security, &lease, &[]);
            leaves.push(lease);
        }
        let mut branches = Vec::new();
        for index in 0..16 {
            let lease = grant(&security, &db, &format!("branch-{index}"), &[]);
            let dependencies = if index < 15 {
                leaves.as_slice()
            } else if extra {
                &leaves[..1]
            } else {
                &[]
            };
            ready(&security, &lease, dependencies);
            branches.push(lease);
        }
        let root = grant(&security, &db, "root", &[]);
        let result = security.begin_runtime(&root, &branches, false);
        assert_eq!(
            result.is_ok(),
            !extra,
            "15*16+16=256; one additional edge must fail"
        );
        if let Ok(pending) = result {
            security.native_ready(&root).unwrap();
            pending.commit();
        }
    }
}

#[test]
fn cached_shared_subtree_still_counts_its_height_on_a_longer_path() {
    let (security, db) = fixture();
    let mut previous = None;
    for i in (0..20).rev() {
        let lease = grant(&security, &db, &format!("a{i}"), &[]);
        ready(&security, &lease, previous.as_slice());
        previous = Some(lease);
    }
    let shared = previous.clone().unwrap();
    for i in (0..12).rev() {
        let lease = grant(&security, &db, &format!("z{i}"), &[]);
        ready(&security, &lease, previous.as_slice());
        previous = Some(lease);
    }
    let root = grant(&security, &db, "root", &[]);
    // The short path caches a0's 20-node height before visiting the 32-node z0.
    assert!(security
        .begin_runtime(&root, &[shared, previous.unwrap()], false)
        .is_err());
    assert!(allowed(&security, &root));
    assert!(!security.policy().runtimes.matches(&root));
}

#[test]
fn reachable_package_budget_counts_shared_nodes_once_and_accepts_exact_boundary() {
    for extra in [false, true] {
        let (security, db) = fixture();
        let mut branches = Vec::new();
        for branch in 0..4 {
            let count = if branch == 3 && !extra { 14 } else { 15 };
            let mut leaves = Vec::new();
            for leaf in 0..count {
                let lease = grant(&security, &db, &format!("leaf-{branch}-{leaf}"), &[]);
                ready(&security, &lease, &[]);
                leaves.push(lease);
            }
            let lease = grant(&security, &db, &format!("branch-{branch}"), &[]);
            ready(&security, &lease, &leaves);
            branches.push(lease);
        }
        let root = grant(&security, &db, "root", &[]);
        let activation = security.begin_runtime(&root, &branches, false);
        assert_eq!(activation.is_ok(), !extra);
        if let Ok(pending) = activation {
            security.native_ready(&root).unwrap();
            pending.commit();
        }
    }
}

#[test]
fn no_permission_mutation_or_lease_refresh_bypasses_failed_transitive_dependency() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &[]);
    ready(&security, &dependency, &[]);
    let middle = grant(&security, &db, "middle", &[]);
    ready(&security, &middle, std::slice::from_ref(&dependency));
    let root = grant(&security, &db, "root", &["log"]);
    ready(&security, &root, &[middle]);
    security.invalidate_runtime(&dependency.id);
    assert!(security
        .with_authorized::<()>(&root, &["log"], || panic!("revoked operation executed"))
        .is_err());
    assert!(!allowed(&security, &root));
}

#[tokio::test]
async fn guard_cancels_on_dependency_retirement_but_survives_unrelated_approval() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &[]);
    ready(&security, &dependency, &[]);
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, std::slice::from_ref(&dependency));
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let worker = {
        let security = security.clone();
        let owner = owner.clone();
        tokio::spawn(async move {
            security
                .guard(&owner, async {
                    entered_tx.send(()).unwrap();
                    std::future::pending::<crate::error::AppResult<()>>().await
                })
                .await
        })
    };
    entered_rx.await.unwrap();
    grant(&security, &db, "unrelated", &[]);
    tokio::task::yield_now().await;
    assert!(!worker.is_finished());
    security.invalidate_runtime(&dependency.id);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}
