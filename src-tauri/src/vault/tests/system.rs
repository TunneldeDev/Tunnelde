//! Explicit native-keyring acceptance using only owned, random QA services.
use super::*;
use sha2::{Digest, Sha256};

struct Fixture {
    store: Vault,
    keys: Vec<String>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            store: Vault::new(&format!("qa.tunnelde-vault.{}", uuid::Uuid::new_v4())).unwrap(),
            keys: Vec::new(),
        }
    }

    fn save(&mut self, key: &str, value: &str) {
        self.keys.push(key.to_owned());
        self.store.save(key, value).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for key in &self.keys {
            let _ = self.store.forget(key);
        }
    }
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[test]
#[ignore = "explicit isolated real-OS keyring acceptance"]
fn application_credentials_are_isolated_and_survive_process_reconstruction() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_APP_KEYRING").as_deref(),
        Ok("1")
    );
    let mut first = Fixture::new();
    let mut second = Fixture::new();
    let host = uuid::Uuid::new_v4().to_string();
    let keys = [host, "proxy:shared".into(), "plugin:shared:token".into()];
    for key in &keys {
        let first_secret = uuid::Uuid::new_v4().to_string();
        let second_secret = uuid::Uuid::new_v4().to_string();
        first.save(key, &first_secret);
        assert!(second.store.load(key).unwrap().is_none());
        second.save(key, &second_secret);
        assert!(first.store.load(key).unwrap().as_deref() == Some(&first_secret));
        assert!(second.store.load(key).unwrap().as_deref() == Some(&second_secret));

        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vault::tests::system::isolated_keyring_reader_child",
                "--ignored",
            ])
            .env("TUNNELDE_TEST_APP_KEYRING_SERVICE", &first.store.service)
            .env("TUNNELDE_TEST_APP_KEYRING_KEY", key)
            .env("TUNNELDE_TEST_APP_KEYRING_HASH", digest(&first_secret))
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "isolated reader could not reconstruct the credential"
        );

        first.store.forget(key).unwrap();
        first.store.forget(key).unwrap();
        assert!(!first.store.has(key).unwrap());
        assert!(second.store.has(key).unwrap());
        assert!(second.store.load(key).unwrap().as_deref() == Some(&second_secret));
    }

    let settings = crate::network::NetworkSettings {
        profiles: vec![crate::network::ProxyProfile {
            id: "shared".into(),
            name: "QA".into(),
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: "qa".into(),
        }],
        default_proxy: "shared".into(),
        ..Default::default()
    };
    first.save("proxy:shared", "first-secret");
    second.save("proxy:shared", "second-secret");
    let url = |store: &Vault| {
        let raw = crate::network::proxy_url(
            |p| store.load(&format!("proxy:{}", p.id)),
            &settings,
            "updates",
            None,
        )
        .unwrap()
        .unwrap();
        reqwest::Url::parse(&raw).unwrap()
    };
    assert!(url(&first.store).password() == Some("first-secret"));
    assert!(url(&second.store).password() == Some("second-secret"));
    // Explicit cleanup is checked, while Drop still covers earlier assertion failures.
    for fixture in [&first, &second] {
        for key in &fixture.keys {
            fixture.store.forget(key).unwrap();
            assert!(!fixture.store.has(key).unwrap());
        }
    }
}

#[test]
#[ignore = "child of the explicit native-keyring fixture"]
fn isolated_keyring_reader_child() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_APP_KEYRING").as_deref(),
        Ok("1")
    );
    let application = std::env::var("TUNNELDE_TEST_APP_KEYRING_SERVICE").unwrap();
    let suffix = application.strip_prefix("qa.tunnelde-vault.").unwrap();
    assert!(uuid::Uuid::parse_str(suffix).is_ok());
    let key = std::env::var("TUNNELDE_TEST_APP_KEYRING_KEY").unwrap();
    let expected = std::env::var("TUNNELDE_TEST_APP_KEYRING_HASH").unwrap();
    let value = Vault::new(&application)
        .unwrap()
        .load(&key)
        .unwrap()
        .unwrap();
    assert!(digest(&value) == expected);
}
