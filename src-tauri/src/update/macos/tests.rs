use super::*;

struct Fixture {
    _staging: Staging,
    bundle: PathBuf,
}
impl Fixture {
    fn new(architecture: &str) -> Self {
        let staging = Staging::new().unwrap();
        let bundle = staging.0.join("Tunnelde.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.tunnelde.qa-update</string>
<key>CFBundleShortVersionString</key><string>1.2.0</string>
<key>CFBundleExecutable</key><string>tunnelde</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#,
        )
        .unwrap();
        let source = staging.0.join("main.c");
        std::fs::write(&source, "int main(void) { return 0; }\n").unwrap();
        assert!(Command::new("/usr/bin/clang")
            .args(["-arch", architecture])
            .arg(&source)
            .arg("-o")
            .arg(bundle.join("Contents/MacOS/tunnelde"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("/usr/bin/codesign")
            .args(["--sign", "-"])
            .arg(&bundle)
            .status()
            .unwrap()
            .success());
        Self {
            _staging: staging,
            bundle,
        }
    }
    fn package(&self) -> Vec<u8> {
        let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        archive
            .append_dir_all("Tunnelde.app", &self.bundle)
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    }
}
fn architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    }
}
fn validate(bytes: &[u8]) -> AppResult<()> {
    validate_package(
        bytes,
        "dev.tunnelde.qa-update",
        "1.2.0",
        OsStr::new("tunnelde"),
    )
}

#[test]
fn native_bundle_identity_version_executable_and_signature_are_required() {
    let fixture = Fixture::new(architecture());
    let bytes = fixture.package();
    validate(&bytes).unwrap();
    for (id, version, name) in [
        ("dev.other.app", "1.2.0", "tunnelde"),
        ("dev.tunnelde.qa-update", "1.2.1", "tunnelde"),
        ("dev.tunnelde.qa-update", "1.2.0", "other"),
    ] {
        assert!(validate_package(&bytes, id, version, OsStr::new(name)).is_err());
    }
    std::fs::write(
        fixture.bundle.join("Contents/MacOS/tunnelde"),
        b"invalid executable",
    )
    .unwrap();
    assert!(validate(&fixture.package()).is_err());
}

#[test]
fn signed_bundle_for_another_architecture_is_rejected() {
    let other = if cfg!(target_arch = "aarch64") {
        "x86_64"
    } else {
        "arm64"
    };
    let fixture = Fixture::new(other);
    assert_eq!(
        validate(&fixture.package()).unwrap_err().to_string(),
        "updates.macArchitectureMismatch"
    );
}

#[test]
fn only_writable_bundle_locations_offer_installation() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(architecture());
    let executable = fixture.bundle.join("Contents/MacOS/tunnelde");
    install_location(&executable).unwrap();
    assert_eq!(
        install_location(Path::new("/usr/bin/true")),
        Err("location")
    );
    let parent = fixture.bundle.parent().unwrap();
    let permissions = std::fs::metadata(parent).unwrap().permissions();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = install_location(&executable);
    std::fs::set_permissions(parent, permissions).unwrap();
    assert_eq!(result, Err("location"));
    xattr::set(
        &fixture.bundle,
        "com.apple.quarantine",
        b"0081;00000000;Tunnelde QA;",
    )
    .unwrap();
    install_location(&executable).unwrap();
    validate_current(&executable).unwrap();
    validate(&fixture.package()).unwrap();
    // Presence of quarantine does not reject a previously approved installation.
    // No quarantine removal or OS policy change is needed for native verification.
}

#[test]
fn archive_links_and_multiple_bundles_are_rejected() {
    let staging = Staging::new().unwrap();
    std::fs::create_dir(staging.0.join("Tunnelde.app")).unwrap();
    std::os::unix::fs::symlink("/", staging.0.join("Tunnelde.app/outside")).unwrap();
    let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    archive.follow_symlinks(false);
    archive
        .append_dir_all("Tunnelde.app", staging.0.join("Tunnelde.app"))
        .unwrap();
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    assert!(validate(&bytes).is_err());
    let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    archive.append_dir("One.app", &staging.0).unwrap();
    archive.append_dir("Two.app", &staging.0).unwrap();
    assert!(validate(&archive.into_inner().unwrap().finish().unwrap()).is_err());
}

#[test]
fn native_helper_timeout_rejection_and_output_limits_are_distinct() {
    let timeout = native_output_with_budget(
        "qa-timeout",
        "updates.invalidMacBundle",
        Command::new("/bin/sleep").arg("2"),
        Duration::from_millis(30),
    );
    assert_eq!(timeout.unwrap_err().to_string(), "updates.timeout");
    let rejected = native_output(
        "qa-architecture",
        "updates.macArchitectureMismatch",
        &mut Command::new("/usr/bin/false"),
    );
    assert_eq!(
        rejected.unwrap_err().to_string(),
        "updates.macArchitectureMismatch"
    );
    let oversized = native_output(
        "qa-output",
        "updates.invalidMacBundle",
        &mut Command::new("/usr/bin/yes"),
    );
    assert_eq!(
        oversized.unwrap_err().to_string(),
        "updates.invalidMacBundle"
    );
}
