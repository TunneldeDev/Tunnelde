use super::*;

#[test]
fn stale_setup_never_creates_a_token_after_retirement() {
    let fixture = Fixture::new();
    let mut first = fixture.create();
    let reserved = reserve(&mut first, "note");
    let mut second = Journal::open(&fixture.path()).unwrap();
    let retired = second.retire(&reserved).unwrap();
    let mut called = false;
    assert!(first
        .provision(&reserved, || {
            called = true;
            Ok(())
        })
        .is_err());
    assert!(!called);
    assert!(first.current(&retired).is_ok());
}

#[test]
fn failed_credential_cleanup_preserves_retirement_and_stale_finalizers_do_not_delete_again() {
    let fixture = Fixture::new();
    let mut first = fixture.create();
    let reserved = reserve(&mut first, "note");
    let retired = first.retire(&reserved).unwrap();
    let mut second = Journal::open(&fixture.path()).unwrap();
    assert!(first
        .forget_retired(&retired, || Err(Error::SecretUnavailable))
        .is_err());
    assert!(second.current(&retired).is_ok());
    second.forget_retired(&retired, || Ok(())).unwrap();
    let later = reserve(&mut second, "note");
    let mut called = false;
    assert!(first
        .forget_retired(&retired, || {
            called = true;
            Ok(())
        })
        .is_err());
    assert!(!called);
    assert!(first.current(&later).is_ok());
}
