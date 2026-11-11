use super::*;
use std::io::{Read, Write};

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-reader-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reader_keeps_writer_sharing_and_follows_the_opened_handle_after_rename() {
    let root = Root::new();
    let path = root.0.join("active.log");
    let mut writer = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .unwrap();
    writer.write_all(b"first").unwrap();
    let mut reader = open_read(&path).unwrap();
    writer.write_all(b" second").unwrap();
    writer.flush().unwrap();
    let moved = root.0.join("renamed.log");
    std::fs::rename(&path, &moved).unwrap();
    std::fs::write(&path, b"replacement").unwrap();
    let mut content = String::new();
    reader.read_to_string(&mut content).unwrap();
    assert_eq!(content, "first second");
    assert!(open_read(&root.0).is_err());
}

#[cfg(unix)]
#[test]
fn final_symlink_and_fifo_replacements_are_rejected_without_blocking() {
    use std::os::unix::fs::symlink;
    let root = Root::new();
    let target = root.0.join("target");
    std::fs::write(&target, b"data").unwrap();
    let link = root.0.join("link");
    symlink(&target, &link).unwrap();
    assert!(open_read(&link).is_err());
    // Bypass the preliminary metadata check to reproduce a replacement just
    // after it: the final open must still refuse to follow a new symlink.
    assert!(open_handle(&link).is_err());
    let fifo = root.0.join("fifo");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    assert!(open_read(&fifo).is_err());
    // O_NONBLOCK avoids waiting for a FIFO writer; fstat rejects the handle.
    let started = std::time::Instant::now();
    assert!(open_handle(&fifo).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(open_handle(Path::new("/dev/null")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_reparse_replacement_is_not_followed() {
    use std::os::windows::fs::symlink_file;
    let root = Root::new();
    let target = root.0.join("target");
    std::fs::write(&target, b"data").unwrap();
    let link = root.0.join("link");
    match symlink_file(&target, &link) {
        Ok(()) => {
            assert!(open_read(&link).is_err());
            assert!(open_handle(&link).is_err());
        }
        Err(error) if error.raw_os_error() == Some(1314) => {
            eprintln!("Symlink privilege unavailable; read/write sharing still tested separately");
        }
        Err(error) => panic!("Unable to prepare symlink: {error}"),
    }
}
