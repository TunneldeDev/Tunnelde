use super::*;

mod system;

#[test]
fn production_identifier_keeps_the_historical_service_without_os_access() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let application = config["identifier"].as_str().unwrap();
    assert_eq!(application, "dev.tunnelde.app");
    assert_eq!(Vault::new(application).unwrap().service, "dev.tunnelde.app");
    assert_eq!(
        Vault::new("dev.tunnelde.qa.credentials").unwrap().service,
        "dev.tunnelde.qa.credentials"
    );
}

#[test]
fn invalid_application_identity_cannot_silently_use_the_production_vault() {
    for application in [
        "",
        "qa\nproduction",
        "qa/production",
        "qa:production",
        " qa",
    ] {
        assert!(Vault::new(application).is_err());
    }
    assert!(Vault::new(&"a".repeat(129)).is_err());
}
