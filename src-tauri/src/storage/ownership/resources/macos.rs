//! Compare missing destinations using each parent volume's filename rules.
//! Canonical paths alone do not collapse case aliases for not-yet-created files.
use std::ffi::{c_char, c_int, c_long, CString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

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

pub(super) fn normalize_case(path: &Path) -> io::Result<PathBuf> {
    let mut original = PathBuf::new();
    let mut result = PathBuf::new();
    let mut case_sensitive = true;
    for part in path.components() {
        if let Component::Normal(name) = part {
            if original.try_exists()? {
                case_sensitive = sensitive(&original)?;
            }
            if case_sensitive {
                result.push(name);
            } else {
                let name = name.to_str().ok_or_else(|| {
                    io::Error::other("Storage ownership paths must be valid Unicode")
                })?;
                result.push(name.to_lowercase());
            }
        } else {
            result.push(part);
        }
        original.push(part);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::ownership::resources::tests::Fixture;

    #[test]
    fn missing_and_created_case_aliases_follow_native_volume_semantics() {
        let f = Fixture::new();
        let first = f.0.join("FutureCase");
        let second = f.0.join("futurecase");
        let sensitive = sensitive(&f.0).unwrap();
        let owner = f.acquire(std::slice::from_ref(&first)).unwrap();
        assert_eq!(f.acquire(std::slice::from_ref(&second)).is_ok(), sensitive);
        std::fs::create_dir(&first).unwrap();
        assert_eq!(f.acquire(&[second.join("child")]).is_ok(), sensitive);
        drop(owner);
    }
}
