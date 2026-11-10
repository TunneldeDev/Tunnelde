use super::*;

#[tokio::test]
async fn local_text_reads_are_bounded_and_reject_nonregular_or_binary_inputs() {
    let root = std::env::temp_dir().join(format!("tunnelde-plugin-read-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("note.txt");
    for (bytes, error) in [
        (b"hello".to_vec(), None),
        (vec![b'x'; MAX_TEXT], None),
        (vec![b'x'; MAX_TEXT + 1], Some("plugin.api.fileTooLarge")),
        (vec![b'a', 0], Some("plugin.api.invalidText")),
        (vec![255], Some("plugin.api.invalidText")),
    ] {
        std::fs::write(&file, &bytes).unwrap();
        let result = local_read(file.to_string_lossy().into_owned()).await;
        if let Some(error) = error {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(
                result.unwrap(),
                json!({"size":bytes.len(),"content":String::from_utf8(bytes).unwrap()})
            );
        }
    }
    assert!(local_read(root.to_string_lossy().into_owned())
        .await
        .is_err());
    #[cfg(unix)]
    {
        let fifo = root.join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .args(["-m", "600"])
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(2),
            local_read(fifo.to_string_lossy().into_owned())
        )
        .await
        .unwrap()
        .is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn refuses_large_or_binary_text_instead_of_truncating_it() {
    assert!(validate_text(b"hello").is_ok());
    assert!(validate_text(b"hello\0secret").is_err());
    assert!(validate_text(&[0xff]).is_err());
    assert!(validate_text(&vec![b'a'; MAX_TEXT + 1]).is_err());
}
