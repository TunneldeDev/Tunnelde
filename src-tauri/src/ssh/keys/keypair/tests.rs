use super::*;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tunnelde-key-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn key_created_by_another_setup_before_publication_is_never_replaced() {
    let directory = Directory::new();
    let mut winner = None;
    let result = ensure_with(&directory.0, |path| {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(key_error)?;
        let pem = key.to_openssh(LineEnding::LF).map_err(key_error)?;
        fs::write(path, pem.as_bytes())?;
        winner = Some((
            pem.as_bytes().to_vec(),
            key.public_key().to_openssh().map_err(key_error)?,
        ));
        Ok(())
    });
    let original = winner.unwrap();
    assert!(
        fs::read(directory.0.join("tunnelde_ed25519")).unwrap() == original.0,
        "a key published by a competing setup was overwritten"
    );
    assert_eq!(result.unwrap().1, original.1);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn concurrent_first_setup_keeps_one_complete_private_key() {
    let directory = Directory::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let barrier = barrier.clone();
            let directory = directory.0.clone();
            std::thread::spawn(move || {
                barrier.wait();
                ensure_keypair(&directory).map(|(_, public)| public)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let expected = ensure_keypair(&directory.0).unwrap().1;
    for result in results {
        assert_eq!(result.unwrap(), expected);
    }
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn repeated_setup_does_not_rewrite_the_private_key() {
    let directory = Directory::new();
    let first = ensure_keypair(&directory.0).unwrap();
    let bytes = fs::read(&first.0).unwrap();
    let modified = fs::metadata(&first.0).unwrap().modified().unwrap();
    assert_eq!(ensure_keypair(&directory.0).unwrap(), first);
    assert!(fs::read(&first.0).unwrap() == bytes);
    assert_eq!(
        fs::metadata(&first.0).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn invalid_existing_key_is_preserved_instead_of_regenerated() {
    let directory = Directory::new();
    let path = directory.0.join("tunnelde_ed25519");
    fs::write(&path, b"existing invalid key").unwrap();
    assert!(ensure_keypair(&directory.0).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"existing invalid key");
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn failed_publication_cleans_its_private_staging_file() {
    let directory = Directory::new();
    let result = ensure_with(&directory.0, |_| {
        Err(key_error("injected publication failure"))
    });
    assert!(result.is_err());
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
}

#[test]
fn directory_at_the_managed_key_path_is_not_replaced() {
    let directory = Directory::new();
    let path = directory.0.join("tunnelde_ed25519");
    fs::create_dir(&path).unwrap();
    assert!(ensure_keypair(&directory.0).is_err());
    assert!(path.is_dir());
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn generated_key_is_private_and_symlink_targets_are_not_read_or_replaced() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let directory = Directory::new();
    let (path, _) = ensure_keypair(&directory.0).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let other = Directory::new();
    symlink(&path, other.0.join("tunnelde_ed25519")).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(ensure_keypair(&other.0).is_err());
    assert!(fs::read(&path).unwrap() == bytes);
}
