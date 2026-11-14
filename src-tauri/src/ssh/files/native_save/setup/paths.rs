//! SFTP names and native authority names are distinct Windows representations.
use crate::{
    error::{AppError, AppResult},
    ssh::files::native_save::contracts::authority::Platform,
};

mod windows;
pub(super) use windows::scope_script;

pub(in crate::ssh::files::native_save) fn canonical_path(
    path: String,
    platform: Platform,
) -> String {
    if platform != Platform::Windows {
        return path;
    }
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
    let path = if path.starts_with('/') && path.as_bytes().get(2) == Some(&b':') {
        &path[1..]
    } else {
        path
    };
    path.replace('\\', "/")
}

pub(in crate::ssh::files::native_save) fn split(
    path: &str,
    platform: Platform,
) -> AppResult<(String, String)> {
    let path = canonical_path(path.into(), platform);
    if !platform.absolute(&path) {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    let (parent, name) = path
        .rsplit_once('/')
        .ok_or_else(|| AppError::validation("sftp.invalidName"))?;
    if matches!(name, "" | "." | "..") {
        return Err(AppError::validation("sftp.invalidName"));
    }
    // A drive root needs its slash; D: alone is a drive-relative path.
    let parent = if parent.is_empty() {
        "/".into()
    } else if platform == Platform::Windows && parent.ends_with(':') {
        format!("{parent}/")
    } else {
        parent.into()
    };
    Ok((parent, name.into()))
}
