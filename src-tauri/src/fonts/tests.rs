use super::*;
use std::path::PathBuf;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-font-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".staging")).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn woff(format: &[u8; 4]) -> Vec<u8> {
    let mut bytes = vec![0; 64];
    bytes[..4].copy_from_slice(format);
    bytes[4..8].copy_from_slice(b"\0\x01\0\0");
    bytes[8..12].copy_from_slice(&64u32.to_be_bytes());
    bytes[16..20].copy_from_slice(&128u32.to_be_bytes());
    bytes
}

#[test]
fn compressed_fonts_require_bounded_consistent_headers_and_reject_collections() {
    for (magic, format) in [(b"wOFF", "woff"), (b"wOF2", "woff2")] {
        let mut bytes = woff(magic);
        assert_eq!(repository::validate_bytes(&bytes).unwrap(), format);
        bytes[8..12].copy_from_slice(&999u32.to_be_bytes());
        assert!(repository::validate_bytes(&bytes).is_err());
        bytes[8..12].copy_from_slice(&64u32.to_be_bytes());
        bytes[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(repository::validate_bytes(&bytes).is_err());
        bytes[16..20].copy_from_slice(&128u32.to_be_bytes());
        bytes[4..8].copy_from_slice(b"ttcf");
        assert!(repository::validate_bytes(&bytes).is_err());
    }
    for invalid in [b"ttcf".as_slice(), b"not a font", b"wOFF", b"OTTO"] {
        assert!(repository::validate_bytes(invalid).is_err());
    }
    let mut bytes = vec![0; MAX_BYTES as usize + 1];
    bytes[..4].copy_from_slice(b"wOFF");
    assert_eq!(
        repository::validate_bytes(&bytes).unwrap_err().to_string(),
        "fonts.tooLarge"
    );
}

#[test]
fn staged_imports_commit_once_deduplicate_by_content_and_cancel_without_publishing() {
    let temp = Temp::new();
    let registry = Registry::default();
    let source = temp.0.join("example.woff2");
    std::fs::write(&source, woff(b"wOF2")).unwrap();
    let first = repository::stage_at(&temp.0, &registry, &source).unwrap();
    let FontReference::Imported { id } = &first.font.reference else {
        panic!()
    };
    assert!(!temp.0.join(id).exists());
    let saved = repository::finish_at(&temp.0, &registry, &first.token, true, true)
        .unwrap()
        .unwrap();
    assert!(saved.monospaced);
    assert_eq!(
        std::fs::read(temp.0.join(id).join("font")).unwrap(),
        woff(b"wOF2")
    );
    assert!(repository::finish_at(&temp.0, &registry, &first.token, true, true).is_err());
    let repeated = repository::stage_at(&temp.0, &registry, &source).unwrap();
    assert_eq!(repeated.font.reference, first.font.reference);
    let existing = repository::finish_at(&temp.0, &registry, &repeated.token, true, false)
        .unwrap()
        .unwrap();
    assert!(existing.monospaced); // Reimport does not mutate a committed font.
    let cancelled = repository::stage_at(&temp.0, &registry, &source).unwrap();
    assert!(
        repository::finish_at(&temp.0, &registry, &cancelled.token, false, false)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(temp.0.join(".staging")).unwrap().count(),
        0
    );
}

#[test]
fn expired_and_excessive_stages_do_not_publish_and_old_settings_have_default_choices() {
    let temp = Temp::new();
    let registry = Registry::default();
    let path = temp.0.join("example.woff");
    std::fs::write(&path, woff(b"wOFF")).unwrap();
    let first = repository::stage_at(&temp.0, &registry, &path).unwrap();
    for _ in 0..3 {
        repository::stage_at(&temp.0, &registry, &path).unwrap();
    }
    assert_eq!(
        repository::stage_at(&temp.0, &registry, &path)
            .unwrap_err()
            .to_string(),
        "fonts.busy"
    );
    registry
        .staging
        .lock()
        .unwrap()
        .get_mut(&first.token)
        .unwrap()
        .created = std::time::Instant::now() - std::time::Duration::from_secs(601);
    assert!(repository::finish_at(&temp.0, &registry, &first.token, true, false).is_err());
    repository::stage_at(&temp.0, &registry, &path).unwrap();
    assert!(!registry.staging.lock().unwrap().contains_key(&first.token));
    let settings: crate::settings::Settings =
        serde_json::from_str(r#"{"monoFont":"jetbrains-mono"}"#).unwrap();
    assert_eq!(settings.mono_font, "jetbrains-mono");
    assert_eq!(settings.font_selections, FontSelections::default());
}

#[test]
fn references_are_path_free_and_deleting_a_font_only_resets_its_active_targets() {
    assert!(!valid_id("../font"));
    assert!(!valid_id(&"A".repeat(64)));
    let imported = FontReference::Imported { id: "a".repeat(64) };
    let mut choices = FontSelections {
        ui: Some(imported.clone()),
        mono: Some(FontReference::System {
            family: "Consolas".into(),
        }),
        editor_cjk: Some(imported),
    };
    choices.without(&"a".repeat(64));
    assert!(choices.ui.is_none() && choices.editor_cjk.is_none());
    assert!(choices.mono.is_some());
    choices.ui = Some(FontReference::System {
        family: "\n".into(),
    });
    choices.editor_cjk = Some(FontReference::Imported {
        id: "../outside".into(),
    });
    choices.sanitize();
    assert!(choices.ui.is_none() && choices.editor_cjk.is_none());
}
