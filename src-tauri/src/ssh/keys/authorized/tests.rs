use super::*;
#[path = "test_support.rs"]
mod support;
use std::sync::atomic::{AtomicUsize, Ordering};
use support::{client, Tree};

const LINE: &str = "ssh-ed25519 AAAAC3Nza tunnelde";

#[tokio::test]
async fn creates_missing_directory_and_file_with_private_modes() {
    let (sftp, tree) = client(Tree::default()).await;
    assert!(append(&sftp, LINE, || async { Ok(()) }).await.unwrap());
    let tree = tree.lock().unwrap();
    assert_eq!(
        tree.bytes.as_ref().unwrap(),
        format!("\n{LINE}\n").as_bytes()
    );
    assert_eq!(tree.modes, [0o700, 0o600]);
    assert_eq!(
        tree.opens.last().unwrap().bits(),
        (OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE).bits()
    );
    assert_eq!(tree.closes, 1);
}

#[tokio::test]
async fn preserves_concurrent_entries_even_when_read_observed_a_missing_file() {
    for existing in [None, Some(b"existing without newline".to_vec())] {
        let original = existing.clone().unwrap_or_default();
        let (sftp, tree) = client(Tree {
            directory: true,
            bytes: existing,
            external: Some(b"\nconcurrent without newline".to_vec()),
            ..Default::default()
        })
        .await;
        append(&sftp, LINE, || async { Ok(()) }).await.unwrap();
        let expected = [
            original,
            b"\nconcurrent without newline".to_vec(),
            format!("\n{LINE}\n").into_bytes(),
        ]
        .concat();
        assert_eq!(tree.lock().unwrap().bytes.as_ref().unwrap(), &expected);
    }
}

#[tokio::test]
async fn repeated_setup_does_not_append_the_same_key_again() {
    let (sftp, tree) = client(Tree::default()).await;
    append(&sftp, LINE, || async { Ok(()) }).await.unwrap();
    let bytes = tree.lock().unwrap().bytes.clone();
    assert!(!append(&sftp, LINE, || async { Ok(()) }).await.unwrap());
    let tree = tree.lock().unwrap();
    assert_eq!(tree.bytes, bytes);
    assert_eq!(
        tree.opens
            .iter()
            .filter(|flags| flags.contains(OpenFlags::WRITE))
            .count(),
        1
    );
}

#[tokio::test]
async fn unreadable_or_invalid_contents_are_never_treated_as_missing() {
    for (failure, bytes) in [
        ("read-open", b"existing".to_vec()),
        ("read", b"existing".to_vec()),
        ("", vec![0xff]),
    ] {
        let (sftp, tree) = client(Tree {
            directory: true,
            bytes: Some(bytes.clone()),
            failure,
            ..Default::default()
        })
        .await;
        assert!(append(&sftp, LINE, || async { Ok(()) }).await.is_err());
        let tree = tree.lock().unwrap();
        assert_eq!(tree.bytes, Some(bytes));
        assert!(tree
            .opens
            .iter()
            .all(|flags| flags.bits() == OpenFlags::READ.bits()));
    }
}

#[tokio::test]
async fn reports_unconfirmed_write_or_close_and_still_attempts_close() {
    for failure in ["write", "close"] {
        let (sftp, tree) = client(Tree {
            directory: true,
            failure,
            ..Default::default()
        })
        .await;
        let error = append(&sftp, LINE, || async { Ok(()) })
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(if failure == "write" {
                "authorized_keys append:"
            } else {
                "authorized_keys append close:"
            }),
            "{error}"
        );
        assert_eq!(tree.lock().unwrap().closes, 1);
        // A failed close may follow a successful remote append; no rollback claim.
        if failure == "close" {
            assert!(tree
                .lock()
                .unwrap()
                .bytes
                .as_ref()
                .unwrap()
                .ends_with(format!("{LINE}\n").as_bytes()));
        }
    }
}

#[tokio::test]
async fn rejects_changed_review_before_directory_or_append_mutation() {
    for fail_at in [1, 2] {
        let (sftp, tree) = client(Tree {
            directory: true,
            bytes: Some(b"existing".to_vec()),
            ..Default::default()
        })
        .await;
        let calls = AtomicUsize::new(0);
        let result = append(&sftp, LINE, || async {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 == fail_at {
                Err(AppError::Ssh("ssh.connectionChanged".into()))
            } else {
                Ok(())
            }
        })
        .await;
        assert_eq!(result.unwrap_err().to_string(), "ssh.connectionChanged");
        let tree = tree.lock().unwrap();
        assert_eq!(tree.bytes.as_ref().unwrap(), b"existing");
        assert!(tree
            .opens
            .iter()
            .all(|flags| flags.bits() == OpenFlags::READ.bits()));
    }
}

#[tokio::test]
async fn only_an_actual_competing_directory_makes_mkdir_failure_usable() {
    for failure in ["mkdir", "competing-mkdir"] {
        let (sftp, tree) = client(Tree {
            failure,
            ..Default::default()
        })
        .await;
        assert_eq!(
            append(&sftp, LINE, || async { Ok(()) }).await.is_ok(),
            failure == "competing-mkdir"
        );
        if failure == "mkdir" {
            assert!(tree.lock().unwrap().opens.is_empty());
        }
    }
}

#[tokio::test]
async fn failed_home_resolution_has_no_relative_path_fallback() {
    let (sftp, tree) = client(Tree {
        failure: "home",
        ..Default::default()
    })
    .await;
    assert!(append(&sftp, LINE, || async { Ok(()) })
        .await
        .unwrap_err()
        .to_string()
        .contains("authorized_keys home:"));
    let tree = tree.lock().unwrap();
    assert!(tree.opens.is_empty());
    assert!(!tree.directory);
}

#[tokio::test]
async fn oversized_authorized_file_fails_before_opening_a_writer() {
    let (sftp, tree) = client(Tree {
        directory: true,
        bytes: Some(vec![b' '; MAX_CONTENTS + 1]),
        ..Default::default()
    })
    .await;
    assert!(append(&sftp, LINE, || async { Ok(()) })
        .await
        .unwrap_err()
        .to_string()
        .contains("4 MiB"));
    let tree = tree.lock().unwrap();
    assert_eq!(tree.bytes.as_ref().unwrap().len(), MAX_CONTENTS + 1);
    assert_eq!(tree.closes, 1);
    assert!(tree
        .opens
        .iter()
        .all(|flags| flags.bits() == OpenFlags::READ.bits()));
}
