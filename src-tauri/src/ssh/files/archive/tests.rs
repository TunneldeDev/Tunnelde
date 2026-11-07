use super::*;

#[test]
fn archives_preserve_empty_binary_unicode_and_maximum_size_files() {
    let files = vec![
        Vec::new(),
        "中文\0 🐦".as_bytes().to_vec(),
        (0..MAX_FILE).map(|index| index as u8).collect(),
    ];
    let lengths = files
        .iter()
        .map(|file| file.len() as u64)
        .collect::<Vec<_>>();
    assert_eq!(
        unpack(pack(files.clone()).unwrap(), &lengths).unwrap(),
        files
    );
    assert!(pack(vec![]).is_err());
    assert!(pack(vec![vec![]; MAX_FILES + 1]).is_err());
    assert!(pack(vec![vec![0; MAX_FILE as usize + 1]]).is_err());
}

fn archive_member(name: &str, kind: tar::EntryType) -> Vec<u8> {
    let mut archive = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_ustar();
    header.set_size(1);
    header.set_mode(0o600);
    header.set_entry_type(kind);
    // Set raw bytes so this fixture can represent malicious traversal.
    header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
    header.set_cksum();
    archive.append(&header, Cursor::new(b"x")).unwrap();
    archive.into_inner().unwrap()
}

#[test]
fn rejects_paths_links_wrong_counts_lengths_and_truncation() {
    for name in ["../outside", "/absolute", "1", "0/child", "00"] {
        assert!(
            unpack(archive_member(name, tar::EntryType::Regular), &[1]).is_err(),
            "{name}"
        );
    }
    for kind in [
        tar::EntryType::Symlink,
        tar::EntryType::Link,
        tar::EntryType::Directory,
        tar::EntryType::Fifo,
        tar::EntryType::XHeader,
        tar::EntryType::GNULongName,
    ] {
        assert!(unpack(archive_member("0", kind), &[1]).is_err(), "{kind:?}");
    }
    let bytes = pack(vec![b"x".to_vec(), b"y".to_vec()]).unwrap();
    assert!(unpack(bytes.clone(), &[1]).is_err());
    assert!(unpack(bytes.clone(), &[1, 2]).is_err());
    assert!(unpack(bytes[..513].to_vec(), &[1, 1]).is_err());
    assert!(unpack(vec![0; MAX_ARCHIVE + 1], &[0]).is_err());
    assert!(unpack(bytes, &[MAX_FILE + 1]).is_err());
}

#[tokio::test]
async fn local_io_is_bounded_and_never_creates_or_truncates_paths() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("archive-local-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let path = root.join("文件.bin");
    tokio::fs::write(&path, b"preserved").await.unwrap();
    let name = display_path(&path);
    assert_eq!(read_local(&name, 9).await.unwrap(), b"preserved");
    assert!(read_local(&name, 2).await.is_err());
    let writer = local_file(&name, true).await.unwrap();
    drop(writer);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"preserved");
    assert!(local_file(&display_path(&root.join("missing")), true)
        .await
        .is_err());
    assert!(local_file(&display_path(&root), false).await.is_err());
    #[cfg(unix)]
    {
        let link = root.join("symlink");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(local_file(&display_path(&link), false).await.is_err());
        assert!(local_file(&display_path(&link), true).await.is_err());
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}
