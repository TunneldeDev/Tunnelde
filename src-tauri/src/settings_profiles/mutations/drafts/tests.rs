use super::*;

fn owner(generation: u64) -> Owner {
    Owner {
        id: "profile-tools".into(),
        fingerprint: "digest".into(),
        generation,
    }
}
fn revision() -> String {
    format!("pc1:{}", "a".repeat(64))
}
fn upload(
    registry: &Registry,
    owner: &Owner,
    id: &str,
    offset: usize,
    text: &str,
) -> AppResult<Draft> {
    registry.append(
        owner,
        contracts::Append {
            draft_id: id.into(),
            offset,
            text: text.into(),
        },
    )
}

#[test]
fn offsets_count_utf8_bytes_and_invalid_appends_preserve_body() {
    let registry = Arc::new(Registry::default());
    let owner = owner(1);
    let draft = registry.prepare(owner.clone(), revision(), 7).unwrap();
    assert_eq!(
        upload(&registry, &owner, &draft.draft_id, 0, "中")
            .unwrap()
            .offset,
        3
    );
    for (offset, text) in [(0, "中"), (2, "x"), (3, "😀x"), (3, "")] {
        assert!(upload(&registry, &owner, &draft.draft_id, offset, text).is_err());
    }
    assert!(registry.claim(&owner, &draft.draft_id).is_err());
    upload(&registry, &owner, &draft.draft_id, 3, "😀").unwrap();
    let claim = registry.claim(&owner, &draft.draft_id).unwrap();
    assert_eq!(claim.text, "中😀");
    assert!(registry.claim(&owner, &draft.draft_id).is_err());
    assert!(registry.discard(&owner, &draft.draft_id).is_err());
    drop(claim);
    registry.discard(&owner, &draft.draft_id).unwrap();
    assert!(registry.claim(&owner, &draft.draft_id).is_err());
}

#[test]
fn ownership_includes_package_fingerprint_and_runtime_generation() {
    let registry = Arc::new(Registry::default());
    let first = owner(1);
    let draft = registry.prepare(first.clone(), revision(), 1).unwrap();
    for foreign in [
        owner(2),
        Owner {
            fingerprint: "changed".into(),
            ..first.clone()
        },
        Owner {
            id: "other".into(),
            ..first.clone()
        },
    ] {
        assert!(upload(&registry, &foreign, &draft.draft_id, 0, "x").is_err());
        registry.discard(&foreign, &draft.draft_id).unwrap();
    }
    upload(&registry, &first, &draft.draft_id, 0, "x").unwrap();
    let claim = registry.claim(&first, &draft.draft_id).unwrap();
    let newer = registry.prepare(owner(2), revision(), 1).unwrap();
    registry.retire_before(&first.id, 2);
    assert!(upload(&registry, &owner(2), &newer.draft_id, 0, "y").is_ok());
    assert_eq!(claim.text, "x");
    assert_eq!(registry.0.lock().unwrap().len(), 2); // worker still charged
    drop(claim);
    assert_eq!(registry.0.lock().unwrap().len(), 1);
}

#[test]
fn idle_absolute_and_retirement_cleanup_leave_claimed_workers_charged() {
    let registry = Arc::new(Registry::default());
    let start = Instant::now();
    let draft = registry.prepare_at(owner(1), revision(), 1, start).unwrap();
    upload(&registry, &owner(1), &draft.draft_id, 0, "x").unwrap();
    let claim = registry.claim(&owner(1), &draft.draft_id).unwrap();
    let idle = registry.prepare_at(owner(1), revision(), 1, start).unwrap();
    assert!(registry.prepare_at(owner(1), revision(), 1, start).is_err());
    registry
        .prepare_at(owner(1), revision(), 1, start + IDLE)
        .unwrap();
    assert!(!registry.0.lock().unwrap().contains_key(&idle.draft_id));
    registry.retire_before("profile-tools", 2);
    assert_eq!(registry.0.lock().unwrap().len(), 1);
    assert!(registry
        .prepare_at(owner(1), revision(), 1, start + LIFETIME)
        .is_ok());
    assert!(registry.0.lock().unwrap().contains_key(&draft.draft_id));
    drop(claim);
    // Touching an upload cannot extend its absolute lifetime.
    let absolute = registry.prepare_at(owner(2), revision(), 1, start).unwrap();
    registry
        .0
        .lock()
        .unwrap()
        .get_mut(&absolute.draft_id)
        .unwrap()
        .touched = start + LIFETIME - Duration::from_secs(1);
    registry
        .prepare_at(owner(3), revision(), 1, start + LIFETIME)
        .unwrap();
    assert!(!registry.0.lock().unwrap().contains_key(&absolute.draft_id));
}

#[test]
fn quotas_include_claimed_work_and_reserved_bytes_before_allocation() {
    let registry = Arc::new(Registry::default());
    let first = registry
        .prepare(owner(1), revision(), MAX_CONTENT_BYTES)
        .unwrap();
    let second = registry
        .prepare(owner(2), revision(), MAX_CONTENT_BYTES)
        .unwrap();
    assert!(registry
        .prepare(
            owner(3),
            revision(),
            MAX_RESERVED - 2 * MAX_CONTENT_BYTES + 1
        )
        .is_err());
    registry.discard(&owner(1), &first.draft_id).unwrap();
    registry.discard(&owner(2), &second.draft_id).unwrap();
    let draft = registry.prepare(owner(1), revision(), 1).unwrap();
    upload(&registry, &owner(1), &draft.draft_id, 0, "x").unwrap();
    let claimed = registry.claim(&owner(1), &draft.draft_id).unwrap();
    registry.prepare(owner(1), revision(), 1).unwrap();
    assert!(registry.prepare(owner(1), revision(), 1).is_err());
    registry.prepare(owner(2), revision(), 1).unwrap();
    registry.prepare(owner(2), revision(), 1).unwrap();
    assert!(registry.prepare(owner(3), revision(), 1).is_err());
    drop(claimed);
    registry.prepare(owner(3), revision(), 1).unwrap();
}
