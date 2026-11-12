//! Explicit fixture for the isolated desktop/OpenSSH acceptance script.
use super::*;

#[test]
#[ignore = "explicit isolated desktop recovery-admission fixture"]
fn native_desktop_write_fence_fixture() {
    let base = PathBuf::from(std::env::var_os("TUNNELDE_TEST_FENCE_ROOT").unwrap());
    assert!(base.is_absolute());
    assert!(base
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("run-"));
    assert_eq!(base.parent().unwrap().file_name().unwrap(), "transfer-lab");
    let input: serde_json::Value =
        serde_json::from_slice(&std::fs::read(base.join("fence-fixture.json")).unwrap()).unwrap();
    let mut authority = authority();
    authority.context.scope = input["remoteRoot"].as_str().unwrap().into();
    assert!(authority
        .context
        .scope
        .starts_with("/tmp/tunnelde-transfer-lab-"));
    authority.context.account = input["username"].as_str().unwrap().into();
    authority.context.host_key = input["fingerprint"].as_str().unwrap().into();
    let prepared = Prepared::new(
        &authority,
        input
            .get("target")
            .map(|value| serde_json::from_value(value.clone()).unwrap())
            .unwrap_or_else(|| vec!["tree".into(), "note.json".into()]),
        Baseline::Absent,
        "{}".into(),
    )
    .unwrap();
    let mut value = binding(&authority, &prepared);
    value.destination.host_id = input["hostId"].as_str().unwrap().into();
    value.destination.address = input["address"].as_str().unwrap().into();
    assert!(value.valid());
    let directory = base.join("data/native-file-saves");
    let mut journal = if directory.exists() {
        Journal::open(&directory).unwrap()
    } else {
        Journal::create(&directory).unwrap()
    };
    let record = journal.reserve(value).unwrap();
    std::fs::write(base.join("fence-operation"), &record.binding.operation_id).unwrap();
}
