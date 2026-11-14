use super::*;
use crate::storage::ownership::resources::tests::Fixture;

#[test]
fn missing_and_created_case_aliases_follow_native_volume_semantics() {
    let f = Fixture::new();
    let first = f.0.join("FutureCase");
    let second = f.0.join("futurecase");
    let sensitive = sensitive(&f.0).unwrap();
    let owner = f.acquire(std::slice::from_ref(&first)).unwrap();
    assert_eq!(f.acquire(std::slice::from_ref(&second)).is_ok(), sensitive);
    std::fs::create_dir(&first).unwrap();
    assert_eq!(f.acquire(&[second.join("child")]).is_ok(), sensitive);
    drop(owner);
}

#[test]
fn unicode_names_fold_cases_without_removing_accents_or_compatibility_distinctions() {
    for (first, second) in [("caf\u{e9}", "cafe\u{301}"), ("\u{3c3}", "\u{3c2}")] {
        assert_eq!(
            normalize_name(first, false).unwrap(),
            normalize_name(second, false).unwrap()
        );
    }
    assert_eq!(
        normalize_name("caf\u{e9}", true).unwrap(),
        normalize_name("cafe\u{301}", true).unwrap()
    );
    for (first, second, sensitive) in [
        ("\u{3c3}", "\u{3c2}", true),
        ("A", "a", true),
        ("caf\u{e9}", "cafe", false),
        ("\u{ff21}", "A", false),
    ] {
        assert_ne!(
            normalize_name(first, sensitive).unwrap(),
            normalize_name(second, sensitive).unwrap()
        );
    }
}

#[test]
fn native_unicode_aliases_are_exclusive_before_creation_and_after_publication() {
    for (first, second) in [("caf\u{e9}", "cafe\u{301}"), ("\u{3c3}", "\u{3c2}")] {
        let f = Fixture::new();
        let probe = f.0.join("probe");
        std::fs::create_dir(&probe).unwrap();
        std::fs::create_dir(probe.join(first)).unwrap();
        let native_alias = probe.join(second).try_exists().unwrap();
        let first = f.0.join(first);
        let second = f.0.join(second);
        let owner = f.acquire(std::slice::from_ref(&first)).unwrap();
        if native_alias {
            assert!(f.acquire(std::slice::from_ref(&second)).is_err());
            assert!(f.acquire(&[second.join("child")]).is_err());
        }
        assert!(!first.exists());
        std::fs::create_dir(&first).unwrap();
        if native_alias {
            assert!(f.acquire(std::slice::from_ref(&second)).is_err());
            assert!(f.acquire(&[second.join("child")]).is_err());
        }
        drop(owner);
        let reused = f.acquire(&[second]).unwrap();
        drop(reused);
    }
}
