use super::super::contracts::authority::Platform;
use super::preparation::split;

#[test]
fn parent_capture_preserves_posix_names_and_windows_drive_roots() {
    assert_eq!(
        split("/file.json", Platform::Posix).unwrap(),
        ("/".into(), "file.json".into())
    );
    assert_eq!(
        split("/qa/a\\b.json", Platform::Posix).unwrap(),
        ("/qa".into(), "a\\b.json".into())
    );
    assert_eq!(
        split(r"C:\file.json", Platform::Windows).unwrap(),
        ("C:/".into(), "file.json".into())
    );
    assert!(split("relative/file", Platform::Posix).is_err());
    assert!(split("/qa/..", Platform::Posix).is_err());
    assert!(split("/qa/", Platform::Posix).is_err());
}
