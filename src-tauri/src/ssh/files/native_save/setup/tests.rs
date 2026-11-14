use super::super::contracts::authority::Platform;
use super::paths::{canonical_path, split};

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

#[test]
fn windows_sftp_editor_paths_keep_native_and_posix_boundaries_distinct() {
    for (path, parent, name) in [
        ("/D:/folder/note.txt", "D:/folder", "note.txt"),
        ("/C:/note.json", "C:/", "note.json"),
        ("/d:/中文目录/文件.txt", "d:/中文目录", "文件.txt"),
        (r"/D:\folder\note.txt", "D:/folder", "note.txt"),
        (r"\\?\D:\folder\note.txt", "D:/folder", "note.txt"),
    ] {
        // SFTP spellings are not accepted by the helper's native contract.
        if !path.starts_with(r"\\?\") {
            assert!(!Platform::Windows.absolute(path));
        }
        assert_eq!(
            split(path, Platform::Windows).unwrap(),
            (parent.into(), name.into())
        );
    }
    assert_eq!(
        split("/D:/folder/note.txt", Platform::Posix).unwrap(),
        ("/D:/folder".into(), "note.txt".into())
    );
    assert_eq!(
        split(r"/D:\folder\note.txt", Platform::Posix).unwrap(),
        ("/".into(), r"D:\folder\note.txt".into())
    );
    for path in [
        "/D:relative.txt",
        "/1:/note.txt",
        "//D:/note.txt",
        "/D:/folder/..",
    ] {
        assert!(split(path, Platform::Windows).is_err(), "{path}");
    }
}

#[test]
fn sftp_spelling_preserves_posix_names_and_maps_windows_native_paths() {
    let path = r"\\?\D:\中文目录\file.txt";
    assert_eq!(
        canonical_path(path.into(), Platform::Windows),
        "D:/中文目录/file.txt"
    );
    assert_eq!(canonical_path(path.into(), Platform::Posix), path);
    assert_eq!(
        canonical_path("/D:/目录".into(), Platform::Posix),
        "/D:/目录"
    );
}
