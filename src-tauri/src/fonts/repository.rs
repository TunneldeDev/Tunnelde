use super::*;
use crate::{state::AppState, storage::layout::Category};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub(super) fn root(app: &tauri::AppHandle) -> PathBuf {
    app.state::<AppState>()
        .storage
        .dir(Category::Database)
        .join("fonts")
}

pub(super) fn initialize(app: &tauri::AppHandle) -> AppResult<()> {
    let registry = app.state::<Registry>();
    let root = root(app);
    std::fs::create_dir_all(&root)?;
    registry.initialized.get_or_init(|| {
        // Tokens are process-local. Nothing left by an earlier process is live.
        let _ = std::fs::remove_dir_all(root.join(".staging"));
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".removed-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    });
    std::fs::create_dir_all(root.join(".staging"))?;
    Ok(())
}

pub(super) fn catalogue(app: &tauri::AppHandle, refresh: bool) -> AppResult<FontCatalogue> {
    let registry = app.state::<Registry>();
    let mut cached = registry.systems.lock().unwrap_or_else(|e| e.into_inner());
    if refresh || cached.is_none() {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families = BTreeMap::<String, bool>::new();
        for face in db.faces() {
            for (family, _) in &face.families {
                if (FontReference::System {
                    family: family.clone(),
                })
                .valid()
                {
                    *families.entry(family.clone()).or_default() |= face.monospaced;
                }
            }
        }
        *cached = Some(
            families
                .into_iter()
                .map(|(family, monospaced)| FontInfo {
                    reference: FontReference::System {
                        family: family.clone(),
                    },
                    name: family,
                    monospaced,
                    format: None,
                    bytes: None,
                })
                .collect(),
        );
    }
    let mut items = cached.as_ref().expect("font catalogue initialized").clone();
    drop(cached);
    let entries = match std::fs::read_dir(root(app)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FontCatalogue { version: 1, items });
        }
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) {
            continue;
        }
        if let Ok(font) = read_info(&entry.path(), &id) {
            items.push(font);
        }
    }
    Ok(FontCatalogue { version: 1, items })
}

fn read_info(directory: &Path, id: &str) -> AppResult<FontInfo> {
    let mut metadata = Vec::new();
    std::fs::File::open(directory.join("metadata.json"))?
        .take(4097)
        .read_to_end(&mut metadata)?;
    if metadata.len() > 4096 {
        return Err(invalid());
    }
    let info: FontInfo = serde_json::from_slice(&metadata)?;
    if info.reference != (FontReference::Imported { id: id.into() })
        || !directory.join("font").is_file()
    {
        return Err(invalid());
    }
    Ok(info)
}

pub(super) fn inspect(path: &Path) -> AppResult<(Vec<u8>, FontInfo)> {
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    let format = validate_bytes(&bytes)?;
    let name = path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Font")
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let mut info = FontInfo {
        reference: FontReference::Imported { id },
        name,
        monospaced: false,
        format: Some(format.into()),
        bytes: Some(bytes.len() as u64),
    };
    if matches!(format, "ttf" | "otf") {
        let mut db = fontdb::Database::new();
        db.load_font_data(bytes.clone());
        let face = db.faces().next().ok_or_else(invalid)?;
        info.monospaced = face.monospaced;
        if let Some((name, _)) = face.families.first() {
            info.name = name.chars().take(128).collect();
        }
    }
    Ok((bytes, info))
}

pub(super) fn validate_bytes(bytes: &[u8]) -> AppResult<&'static str> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::validation("fonts.tooLarge"));
    }
    let signature = bytes.get(..4).ok_or_else(invalid)?;
    let format = match signature {
        b"\0\x01\0\0" | b"true" if bytes.len() >= 12 => "ttf",
        b"OTTO" if bytes.len() >= 12 => "otf",
        b"wOFF" if bytes.len() >= 44 => "woff",
        b"wOF2" if bytes.len() >= 48 => "woff2",
        _ => return Err(invalid()),
    };
    if matches!(format, "woff" | "woff2") {
        if !matches!(&bytes[4..8], b"\0\x01\0\0" | b"OTTO" | b"true") {
            return Err(invalid());
        }
        let length = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let expanded = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as u64;
        if length != bytes.len() || expanded == 0 || expanded > MAX_BYTES {
            return Err(invalid());
        }
    }
    Ok(format)
}

pub(super) fn stage(app: &tauri::AppHandle, path: &Path) -> AppResult<FontImport> {
    initialize(app)?;
    stage_at(&root(app), &app.state::<Registry>(), path)
}

pub(super) fn stage_at(root: &Path, registry: &Registry, path: &Path) -> AppResult<FontImport> {
    let mut stages = registry.staging.lock().unwrap_or_else(|e| e.into_inner());
    stages.retain(|_, stage| {
        if stage.created.elapsed() < std::time::Duration::from_secs(600) {
            true
        } else {
            let _ = std::fs::remove_dir_all(&stage.directory);
            false
        }
    });
    if stages.len() >= 4 {
        return Err(AppError::validation("fonts.busy"));
    }
    let (bytes, font) = inspect(path)?;
    let token = uuid::Uuid::new_v4().to_string();
    let directory = root.join(".staging").join(&token);
    std::fs::create_dir(&directory)?;
    if let Err(error) = std::fs::write(directory.join("font"), bytes) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error.into());
    }
    stages.insert(
        token.clone(),
        Staged {
            directory,
            font: font.clone(),
            created: std::time::Instant::now(),
        },
    );
    Ok(FontImport { token, font })
}

pub(super) fn finish(
    app: &tauri::AppHandle,
    token: &str,
    accepted: bool,
    monospaced: bool,
) -> AppResult<Option<FontInfo>> {
    finish_at(
        &root(app),
        &app.state::<Registry>(),
        token,
        accepted,
        monospaced,
    )
}

pub(super) fn finish_at(
    root: &Path,
    registry: &Registry,
    token: &str,
    accepted: bool,
    monospaced: bool,
) -> AppResult<Option<FontInfo>> {
    let mut stages = registry.staging.lock().unwrap_or_else(|e| e.into_inner());
    let stage = stages.get(token).ok_or_else(invalid)?;
    if !accepted {
        std::fs::remove_dir_all(&stage.directory)?;
        stages.remove(token);
        return Ok(None);
    }
    if stage.created.elapsed() >= std::time::Duration::from_secs(600) {
        return Err(invalid());
    }
    let mut info = stage.font.clone();
    info.monospaced = monospaced;
    let FontReference::Imported { id } = &info.reference else {
        return Err(invalid());
    };
    let destination = root.join(id);
    if destination.exists() {
        let existing = read_info(&destination, id)?;
        std::fs::remove_dir_all(&stage.directory)?;
        stages.remove(token);
        return Ok(Some(existing));
    }
    std::fs::write(
        stage.directory.join("metadata.json"),
        serde_json::to_vec(&info)?,
    )?;
    std::fs::rename(&stage.directory, &destination)?;
    stages.remove(token);
    Ok(Some(info))
}

pub(super) fn resource(app: &tauri::AppHandle, id: &str) -> AppResult<PathBuf> {
    if valid_id(id) {
        return Ok(root(app).join(id).join("font"));
    }
    if let Some(token) = id.strip_prefix("staged-") {
        let registry = app.state::<Registry>();
        let stages = registry.staging.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stage) = stages
            .get(token)
            .filter(|stage| stage.created.elapsed() < std::time::Duration::from_secs(600))
        {
            return Ok(stage.directory.join("font"));
        }
    }
    Err(invalid())
}
