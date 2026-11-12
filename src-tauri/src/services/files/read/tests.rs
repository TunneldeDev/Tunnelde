use super::*;
use std::io::Write;
use std::path::PathBuf;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-file-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn actual_ranges_and_concurrent_offsets_keep_the_same_opened_file() {
    let _serial = SERIAL.lock().await;
    let root = Root::new();
    let path = root.path("bytes");
    let bytes = (0..2 * 1024 * 1024 + 73)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&path, &bytes).unwrap();
    let (reader, size) = LocalReader::open(path.clone()).await.unwrap();
    assert_eq!(size, bytes.len() as u64);
    let (a, b, c) = tokio::join!(
        reader.read(1_000_000, 1_048_576),
        reader.read(10, 30),
        reader.read(size - 73, 73)
    );
    assert_eq!(a.unwrap(), bytes[1_000_000..2_048_576]);
    assert_eq!(b.unwrap(), bytes[10..40]);
    assert_eq!(c.unwrap(), bytes[bytes.len() - 73..]);
    assert_eq!(
        reader.read(0, size).await.unwrap(),
        bytes,
        "whole-image reads above 1 MiB remain supported"
    );
    std::fs::rename(&path, root.path("renamed")).unwrap();
    std::fs::write(&path, b"replacement").unwrap();
    assert_eq!(reader.read(10, 30).await.unwrap(), bytes[10..40]);
}

#[tokio::test]
async fn validates_before_allocation_and_preserves_empty_prefix_and_eof_semantics() {
    let _serial = SERIAL.lock().await;
    let root = Root::new();
    let path = root.path("text");
    std::fs::write(&path, []).unwrap();
    let (reader, size) = LocalReader::open(path.clone()).await.unwrap();
    assert_eq!(size, 0);
    assert!(reader.read(0, 0).await.unwrap().is_empty());
    assert!(reader.prefix(0).await.unwrap().is_empty());
    for (start, len) in [(0, MAX_READ_BYTES + 1), (u64::MAX, 1)] {
        assert_eq!(
            reader.read(start, len).await.unwrap_err().to_string(),
            "fileRead.invalidRange"
        );
    }
    assert!(reader.prefix(MAX_TEXT + 1).await.is_err());
    std::fs::write(&path, b"abcdef").unwrap();
    assert_eq!(reader.prefix(3).await.unwrap(), b"abcd");
    assert_eq!(reader.prefix(0).await.unwrap(), b"a");
    assert_eq!(reader.read(0, 6).await.unwrap(), b"abcdef");
    std::fs::write(&path, b"x").unwrap();
    assert!(
        reader.read(0, 6).await.is_err(),
        "truncation must not return padded or stale bytes"
    );
}

#[tokio::test]
async fn reads_do_not_block_a_live_log_writer() {
    let _serial = SERIAL.lock().await;
    let root = Root::new();
    let path = root.path("software.log");
    let mut writer = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .unwrap();
    writer.write_all(b"first\n").unwrap();
    let (reader, _) = LocalReader::open(path).await.unwrap();
    writer.write_all(b"second\n").unwrap();
    writer.flush().unwrap();
    assert_eq!(reader.prefix(1024).await.unwrap(), b"first\nsecond\n");
}

#[tokio::test]
async fn rejects_invalid_and_nonregular_targets_and_keeps_intentional_aliases() {
    let _serial = SERIAL.lock().await;
    let root = Root::new();
    for path in [
        String::new(),
        "relative.txt".into(),
        "bad\0path".into(),
        root.0.to_string_lossy().into_owned(),
    ] {
        assert!(LocalReader::open(path).await.is_err());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let target = root.path("target");
        std::fs::write(&target, b"alias data").unwrap();
        let link = root.path("alias");
        symlink(&target, &link).unwrap();
        let (reader, _) = LocalReader::open(link).await.unwrap();
        assert_eq!(reader.read(0, 10).await.unwrap(), b"alias data");
        let fifo = root.path("fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), LocalReader::open(fifo))
                .await
                .unwrap()
                .is_err()
        );
    }
}

#[tokio::test]
async fn builtin_preview_retains_its_size_encoding_and_binary_errors() {
    let _serial = SERIAL.lock().await;
    let root = Root::new();
    let path = root.path("preview.txt");
    std::fs::write(&path, "你好🌍\n").unwrap();
    assert_eq!(
        crate::commands::search_preview_local(path.clone())
            .await
            .unwrap(),
        "你好🌍\n"
    );
    for (bytes, reason) in [
        (vec![b'x'; 512 * 1024 + 1], "sftp.fileTooLarge"),
        (vec![0], "sftp.binaryFile"),
        (vec![0xff], "sftp.unsupportedEncoding"),
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            crate::commands::search_preview_local(path.clone())
                .await
                .unwrap_err()
                .to_string(),
            reason
        );
    }
    std::fs::write(&path, vec![b'x'; 512 * 1024]).unwrap();
    assert_eq!(
        crate::commands::search_preview_local(path)
            .await
            .unwrap()
            .len(),
        512 * 1024
    );
}
