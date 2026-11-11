use super::*;
#[test]
fn handles_bind_owner_fingerprint_generation_kind_and_instance() {
    let expected = digest("a", "fingerprint", 1, Kind::Connection, "instance");
    assert!(valid(&expected));
    for different in [
        digest("b", "fingerprint", 1, Kind::Connection, "instance"),
        digest("a", "other", 1, Kind::Connection, "instance"),
        digest("a", "fingerprint", 2, Kind::Connection, "instance"),
        digest("a", "fingerprint", 1, Kind::Task, "instance"),
        digest("a", "fingerprint", 1, Kind::Connection, "replacement"),
    ] {
        assert_ne!(expected, different);
    }
    for invalid in [
        "",
        "handle",
        &"A".repeat(64),
        &"z".repeat(64),
        &"a".repeat(63),
        &"a".repeat(65),
    ] {
        assert!(!valid(invalid));
    }
}
