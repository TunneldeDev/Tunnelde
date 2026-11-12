//! Opt-in real OS keyring. The fixture owns a unique QA namespace, never production.
use super::super::*;

struct Cleanup {
    store: System,
    key: String,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.store.entry(&self.key).and_then(|entry| {
            entry
                .delete_credential()
                .map_err(|_| Error::SecretUnavailable)
        });
    }
}
#[test]
#[ignore = "requires explicit isolated real-OS keyring acceptance"]
fn native_system_keyring_survives_process_reconstruction_and_only_deletes_the_original_token() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_NATIVE_KEYRING").as_deref(),
        Ok("1")
    );
    let application = format!("qa.tunnelde-native.{}", uuid::Uuid::new_v4());
    let store = System::new(&application).unwrap();
    let key = format!(
        "{}:{}:{}",
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4()
    );
    let cleanup = Cleanup { store, key };
    let token = contracts::hash(b"qa-keyring-random", uuid::Uuid::new_v4().as_bytes());
    let hash = contracts::hash(b"", token.as_bytes());
    cleanup.store.create(&cleanup.key, &token).unwrap();
    assert_eq!(cleanup.store.load(&cleanup.key).unwrap(), token);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ssh::files::native_save::secrets::tests::system::native_keyring_reader_child",
            "--ignored",
        ])
        .env("TUNNELDE_TEST_NATIVE_KEYRING_APP", &application)
        .env("TUNNELDE_TEST_NATIVE_KEYRING_KEY", &cleanup.key)
        .env("TUNNELDE_TEST_NATIVE_KEYRING_SHA256", &hash)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "isolated child could not read the original system credential"
    );
    assert!(cleanup.store.forget(&cleanup.key, &"0".repeat(64)).is_err());
    assert_eq!(cleanup.store.load(&cleanup.key).unwrap(), token);
    cleanup.store.forget(&cleanup.key, &hash).unwrap();
    assert!(cleanup.store.load(&cleanup.key).is_err());
    cleanup.store.forget(&cleanup.key, &hash).unwrap();
}

#[test]
#[ignore = "isolated OS-keyring child invoked by the explicit parent fixture"]
fn native_keyring_reader_child() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_NATIVE_KEYRING").as_deref(),
        Ok("1")
    );
    let application = std::env::var("TUNNELDE_TEST_NATIVE_KEYRING_APP").unwrap();
    let suffix = application.strip_prefix("qa.tunnelde-native.").unwrap();
    assert!(contracts::uuid(suffix));
    let key = std::env::var("TUNNELDE_TEST_NATIVE_KEYRING_KEY").unwrap();
    let expected = std::env::var("TUNNELDE_TEST_NATIVE_KEYRING_SHA256").unwrap();
    let token = System::new(&application).unwrap().load(&key).unwrap();
    assert!(contracts::hash(b"", token.as_bytes()) == expected);
}
