//! Compare missing destinations using each parent volume's filename rules.
//! Canonical paths alone do not collapse case aliases for not-yet-created files.
use std::ffi::{c_char, c_int, c_long, CString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use objc2_core_foundation::{
    CFMutableString, CFString, CFStringCompareFlags, CFStringNormalizationForm,
};

unsafe extern "C" {
    fn pathconf(path: *const c_char, name: c_int) -> c_long;
}

fn sensitive(parent: &Path) -> io::Result<bool> {
    let parent = CString::new(parent.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // Darwin sys/unistd.h: _PC_CASE_SENSITIVE = 11. Query the real parent,
    // so a mounted case-sensitive volume retains its own filename semantics.
    let result = unsafe { pathconf(parent.as_ptr(), 11) };
    match result {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(io::Error::other(
            "Cannot determine storage volume case sensitivity",
        )),
    }
}

fn normalize_name(name: &str, case_sensitive: bool) -> io::Result<String> {
    if name.is_ascii() {
        return Ok(if case_sensitive {
            name.to_owned()
        } else {
            name.to_ascii_lowercase()
        });
    }
    let original = CFString::from_str(name);
    let normalized = CFMutableString::new_copy(None, 0, Some(&original))
        .ok_or_else(|| io::Error::other("Cannot normalize storage ownership filename"))?;
    if !case_sensitive {
        // Lowercasing misses case-fold aliases such as Greek sigma/final sigma.
        CFMutableString::fold(
            Some(&normalized),
            CFStringCompareFlags::CompareCaseInsensitive,
            None,
        );
    }
    // APFS also aliases canonical Unicode spellings on case-sensitive volumes.
    // Conservatively reserve those spellings on other Mac-mounted filesystems.
    // SAFETY: A valid owned mutable string and a supported normalization form.
    unsafe { CFMutableString::normalize(Some(&normalized), CFStringNormalizationForm::D) };
    Ok(normalized.to_string())
}

pub(super) fn normalize_names(path: &Path) -> io::Result<PathBuf> {
    let mut original = PathBuf::new();
    let mut result = PathBuf::new();
    let mut case_sensitive = true;
    for part in path.components() {
        if let Component::Normal(name) = part {
            if original.try_exists()? {
                case_sensitive = sensitive(&original)?;
            }
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("Storage ownership paths must be valid Unicode"))?;
            result.push(normalize_name(name, case_sensitive)?);
        } else {
            result.push(part);
        }
        original.push(part);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
