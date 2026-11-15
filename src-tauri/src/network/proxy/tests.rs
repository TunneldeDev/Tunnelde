use super::*;
use std::cell::Cell;

fn authenticated() -> NetworkSettings {
    NetworkSettings {
        profiles: vec![ProxyProfile {
            id: "office".into(),
            name: "Office".into(),
            protocol: "socks5".into(),
            host: "::1".into(),
            port: 1080,
            username: "user@qa".into(),
        }],
        default_proxy: "office".into(),
        ..Default::default()
    }
}

#[test]
fn authenticated_routes_validate_without_credential_access_and_resolve_only_when_needed() {
    let network = authenticated();
    validate_selection(&network, "ssh", None).unwrap();
    let reads = Cell::new(0);
    let value = Configured::capture(&network, "ssh", None)
        .unwrap()
        .resolve(|key| {
            assert_eq!(key, "proxy:office");
            reads.set(reads.get() + 1);
            Ok(Some("p@ss:/".into()))
        })
        .unwrap()
        .unwrap();
    let url = reqwest::Url::parse(&value).unwrap();
    assert_eq!(url.scheme(), "socks5h");
    assert_eq!(url.host_str(), Some("[::1]"));
    assert_eq!(url.port(), Some(1080));
    assert_eq!(
        percent_encoding::percent_decode_str(url.username())
            .decode_utf8()
            .unwrap(),
        "user@qa"
    );
    assert_eq!(
        percent_encoding::percent_decode_str(url.password().unwrap())
            .decode_utf8()
            .unwrap(),
        "p@ss:/"
    );
    assert_eq!(reads.get(), 1);
}

#[test]
fn system_direct_and_anonymous_routes_never_open_the_vault() {
    let mut network = authenticated();
    for (chosen, expected) in [("system", None), ("direct", Some(String::new()))] {
        assert_eq!(
            Configured::capture(&network, "ssh", Some(chosen))
                .unwrap()
                .resolve(|_| panic!("non-authenticated selection opened vault"))
                .unwrap(),
            expected
        );
    }
    network.profiles[0].username.clear();
    let value = Configured::capture(&network, "ssh", None)
        .unwrap()
        .resolve(|_| panic!("anonymous profile opened vault"))
        .unwrap()
        .unwrap();
    assert_eq!(value, "socks5h://[::1]:1080");
}

#[test]
fn invalid_or_missing_route_configuration_is_rejected_without_falling_back() {
    let mut network = authenticated();
    assert_eq!(
        validate_selection(&network, "ssh", Some("missing"))
            .unwrap_err()
            .to_string(),
        "network.proxyMissing"
    );
    network.profiles[0].host = "/".into();
    assert_eq!(
        validate_selection(&network, "ssh", None)
            .unwrap_err()
            .to_string(),
        "network.invalid"
    );
}

#[test]
fn configured_route_resolution_preserves_vault_failure_and_empty_password_semantics() {
    let network = authenticated();
    let result = Configured::capture(&network, "ssh", None)
        .unwrap()
        .resolve(|_| Err(AppError::Ssh("vault.load: controlled failure".into())));
    assert_eq!(
        result.unwrap_err().to_string(),
        "vault.load: controlled failure"
    );
    let value = Configured::capture(&network, "ssh", None)
        .unwrap()
        .resolve(|_| Ok(None))
        .unwrap()
        .unwrap();
    assert_eq!(reqwest::Url::parse(&value).unwrap().username(), "user%40qa");
    // url normalizes an empty password away; retain the pre-extraction wire URL.
    assert_eq!(value, "socks5h://user%40qa@[::1]:1080");
    assert_eq!(reqwest::Url::parse(&value).unwrap().password(), None);
}
