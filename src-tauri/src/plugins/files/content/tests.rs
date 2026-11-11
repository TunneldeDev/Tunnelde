use super::{contracts::*, entry::Entry, Content};
use crate::{
    plugins::security::Lease,
    services::files::read::{LocalReader, Source},
};
use std::sync::Arc;

fn lease(owner: &str, generation: u64) -> Lease {
    Lease {
        id: owner.into(),
        generation,
        fingerprint: "a".repeat(64),
        permissions: vec!["fs.read".into()],
    }
}
fn request(path: String) -> Prepare {
    Prepare {
        source: Endpoint::Local {},
        path,
    }
}
fn missing() -> Prepare {
    request(
        std::env::temp_dir()
            .join(format!("tunnelde-content-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned(),
    )
}

#[tokio::test]
async fn prepare_does_no_io_and_late_open_cannot_survive_close_or_runtime_retirement() {
    let content = Content::default();
    let prepared = content.prepare(lease("one", 1), missing()).unwrap();
    let entry = content.get("one", 1, &prepared.content_id).unwrap();
    assert_eq!(entry.observe().state, Phase::Prepared);
    assert!(content.get("other", 1, &prepared.content_id).is_err());
    assert!(content.get("one", 2, &prepared.content_id).is_err());
    assert_eq!(
        content.close("other", 1, &prepared.content_id).unwrap(),
        None
    );
    assert_eq!(
        content.close("one", 1, &prepared.content_id).unwrap(),
        Some(false)
    );
    assert!(entry.begin().is_err());
    assert_eq!(content.close("one", 1, &prepared.content_id).unwrap(), None);
    let prepared = content.prepare(lease("one", 1), missing()).unwrap();
    let entry = content.get("one", 1, &prepared.content_id).unwrap();
    let opening = entry.begin().unwrap();
    assert!(entry.begin().is_err());
    let new = content.prepare(lease("one", 2), missing()).unwrap();
    content.retire_before("one", 2);
    assert!(content.get("one", 1, &prepared.content_id).is_err());
    assert!(content.get("one", 2, &new.content_id).is_ok());
    drop(opening);
    assert_eq!(entry.observe().state, Phase::Closed);
}

#[tokio::test]
async fn prepared_and_opening_descriptors_share_owner_quota_and_exact_receipts() {
    let content = Content::default();
    let mut entries = Vec::new();
    for _ in 0..8 {
        entries.push(content.prepare(lease("one", 1), missing()).unwrap());
    }
    let entry = content.get("one", 1, &entries[0].content_id).unwrap();
    let opening = entry.begin().unwrap();
    assert!(content.prepare(lease("one", 2), missing()).is_err());
    let (receipt, _) = content
        .owned("one", 1)
        .into_iter()
        .find(|(_, e)| e.id == entries[0].content_id)
        .unwrap();
    assert!(content.release("other", 1, &receipt).is_none());
    assert_eq!(content.release("one", 1, &receipt), Some(true));
    let replacement = content.prepare(lease("one", 1), missing()).unwrap();
    drop(opening);
    assert!(content.release("one", 1, &receipt).is_none());
    assert!(content.get("one", 1, &replacement.content_id).is_ok());
}

#[tokio::test]
async fn real_local_reads_preserve_ranges_and_retire_while_an_existing_clone_settles() {
    let dir = std::env::temp_dir().join(format!("tunnelde-content-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("content.bin");
    let bytes: Vec<u8> = (0..120_000).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let entry = Arc::new(Entry::new(request(path.to_string_lossy().into_owned())));
    let opening = entry.begin().unwrap();
    let (reader, size) = LocalReader::open(path.to_string_lossy().into_owned())
        .await
        .unwrap();
    let observed = opening.finish(Source::Local(reader), size).unwrap();
    assert_eq!(observed.state, Phase::Open);
    assert_eq!(observed.size, Some(120_000));
    assert!(entry.begin().is_err());
    assert!(entry.read(0, MAX_CHUNK + 1).is_err());
    assert!(entry.read(size + 1, 1).is_err());
    let reading = entry.read(119_990, 100).unwrap();
    assert_eq!(reading.length, 10);
    assert_eq!(
        reading
            .source
            .read(reading.offset, reading.length)
            .await
            .unwrap(),
        bytes[119_990..]
    );
    assert!(entry.close());
    assert!(reading.check().is_err());
    assert!(entry.read(0, 1).is_err());
    assert_eq!(entry.observe().state, Phase::Closed);
    // In-flight local workers are not claimed to be forcibly interruptible.
    assert_eq!(reading.source.read(3, 10).await.unwrap(), bytes[3..13]);
    drop(reading);
    drop(entry);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_late_success_cannot_install_after_close_and_unknown_prepare_results_expire() {
    let content = Content::default();
    let prepared = content.prepare(lease("one", 1), missing()).unwrap();
    let entry = content.get("one", 1, &prepared.content_id).unwrap();
    let opening = entry.begin().unwrap();
    content.close("one", 1, &prepared.content_id).unwrap();
    let path = std::env::temp_dir().join(format!("tunnelde-late-content-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"late").unwrap();
    let (reader, size) = LocalReader::open(path.to_string_lossy().into_owned())
        .await
        .unwrap();
    assert!(opening.finish(Source::Local(reader), size).is_err());
    std::fs::remove_file(path).unwrap();
    let prepared = content.prepare(lease("one", 1), missing()).unwrap();
    let orphan = Arc::downgrade(&content.get("one", 1, &prepared.content_id).unwrap());
    tokio::task::yield_now().await;
    // Await actual expiry with Tokio's controlled clock, not wall-clock sleeps.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_millis(PREPARED_MS + 1)).await;
    tokio::task::yield_now().await;
    assert!(
        orphan.upgrade().is_none(),
        "The sweeper reclaims idle descriptors without another API call"
    );
    tokio::time::resume();
    assert!(content.get("one", 1, &prepared.content_id).is_err());
}

#[test]
fn wire_inputs_require_explicit_endpoint_absolute_path_and_bounded_ranges() {
    assert!(serde_json::from_value::<Prepare>(
        serde_json::json!({"source":{"kind":"local","sessionId":"hidden"},"path":"/"})
    )
    .is_err());
    for value in [
        serde_json::json!({"source":{"kind":"remote","sessionId":"session"},"path":"relative"}),
        serde_json::json!({"source":{"kind":"local"},"path":"relative"}),
        serde_json::json!({"source":{"kind":"remote","sessionId":""},"path":"/"}),
    ] {
        assert!(serde_json::from_value::<Prepare>(value)
            .unwrap()
            .validate()
            .is_err());
    }
    assert!(serde_json::from_value::<Prepare>(serde_json::json!({"source":{"kind":"local","sessionId":"secret"},"path":"/","owner":"foreign"})).is_err());
    let id = uuid::Uuid::new_v4().to_string();
    for (offset, length) in [(MAX_SAFE_INTEGER + 1, 1), (0, 0), (0, MAX_CHUNK + 1)] {
        assert!(Read {
            content_id: id.clone(),
            offset,
            length
        }
        .validate()
        .is_err());
    }
    assert!(Read {
        content_id: id,
        offset: MAX_SAFE_INTEGER,
        length: MAX_CHUNK
    }
    .validate()
    .is_ok());
}

#[tokio::test]
async fn emit_actual_file_content_contracts() {
    use serde_json::json;
    let path = std::env::temp_dir().join(format!("tunnelde-content-wire-{}", uuid::Uuid::new_v4()));
    let bytes: Vec<_> = (0..100_000).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let content = Content::default();
    let request = request(path.to_string_lossy().into_owned());
    let params = json!({"source":{"kind":"local"},"path":request.path});
    let prepared = content.prepare(lease("fixture", 1), request).unwrap();
    let id = prepared.content_id.clone();
    let mut samples =
        vec![json!({"method":"files.content.prepare","params":params,"result":prepared})];
    let entry = content.get("fixture", 1, &id).unwrap();
    let opening = entry.begin().unwrap();
    let (reader, size) = LocalReader::open(path.to_string_lossy().into_owned())
        .await
        .unwrap();
    let observed = opening.finish(Source::Local(reader), size).unwrap();
    samples
        .push(json!({"method":"files.content.open","params":{"contentId":id},"result":observed}));
    for (offset, length) in [(3, MAX_CHUNK), (99_997, 100), (100_000, 1)] {
        let reading = entry.read(offset, length).unwrap();
        let actual = reading
            .source
            .read(reading.offset, reading.length)
            .await
            .unwrap();
        samples.push(json!({"method":"files.content.read","params":{"contentId":id,"offset":offset,"length":length},"result":reading.finish(actual).unwrap()}));
    }
    samples.push(json!({"method":"files.content.observe","params":{"contentId":id},"result":entry.observe()}));
    content.close("fixture", 1, &id).unwrap();
    samples.push(json!({"method":"files.content.close","params":{"contentId":id},"result":{"version":1,"closed":true}}));
    samples.push(json!({"method":"files.content.observe","params":{"contentId":id},"result":entry.observe()}));
    drop(entry);
    std::fs::remove_file(path).unwrap();
    if let Some(output) = std::env::var_os("TUNNELDE_FILE_CONTENT_OUTPUT") {
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&json!({"samples":samples})).unwrap(),
        )
        .unwrap();
    }
}
