//! Compare canonical remote paths without using the desktop OS's path syntax.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    Posix,
    Windows,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Path {
    root: String,
    components: Vec<String>,
}
impl Path {
    pub(crate) fn new(path: &str, platform: Platform) -> Option<Self> {
        if path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control) {
            return None;
        }
        let (root, tail) = match platform {
            Platform::Posix => ("/".to_owned(), path.strip_prefix('/')?.to_owned()),
            Platform::Windows => {
                let path = path
                    .strip_prefix(r"\\?\")
                    .unwrap_or(path)
                    .replace('\\', "/");
                // OpenSSH SFTP presents Windows drive paths as /C:/..., while
                // the native helper uses C:\... . Never compare these literally.
                let path = path.strip_prefix('/').unwrap_or(&path);
                let bytes = path.as_bytes();
                if bytes.len() < 3
                    || !bytes[0].is_ascii_alphabetic()
                    || bytes[1] != b':'
                    || bytes[2] != b'/'
                {
                    return None;
                }
                (path[..2].to_ascii_uppercase(), path[3..].to_owned())
            }
        };
        let mut components = Vec::new();
        for part in tail.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    components.pop();
                }
                part => components.push(match platform {
                    Platform::Posix => part.to_owned(),
                    Platform::Windows => {
                        // Alternate streams, Win32 trimming and wildcard spellings
                        // cannot prove a disjoint target. Leave them unsupported.
                        if part.contains([':', '<', '>', '"', '|', '?', '*'])
                            || part.ends_with(['.', ' '])
                        {
                            return None;
                        }
                        part.to_uppercase()
                    }
                }),
            }
        }
        Some(Self { root, components })
    }

    /// Both ancestors and descendants conflict. This is deliberately broader
    /// than exact-file exclusion: deleting or renaming a parent also mutates it.
    pub(crate) fn overlaps(&self, other: &Self) -> bool {
        self.root == other.root
            && (self.components.starts_with(&other.components)
                || other.components.starts_with(&self.components))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ancestry_respects_components_and_remote_platform() {
        for (a, b, platform, overlaps) in [
            ("/workspace/a", "/workspace/a/child", Platform::Posix, true),
            ("/workspace/a", "/workspace/abc", Platform::Posix, false),
            ("/workspace/a", "/workspace/A", Platform::Posix, false),
            ("/", "/workspace/a", Platform::Posix, true),
            (
                "/workspace//./a/../b/",
                "/workspace/b",
                Platform::Posix,
                true,
            ),
            (r"/workspace/a\b", "/workspace/a/b", Platform::Posix, false),
            (
                r"C:\Work\Data",
                "/c:/work/data/child",
                Platform::Windows,
                true,
            ),
            (r"\\?\C:\Work\Data", "C:/WORK/DATA", Platform::Windows, true),
            ("C:/work", "D:/work", Platform::Windows, false),
            ("C:/", "c:/work", Platform::Windows, true),
        ] {
            let a = Path::new(a, platform).unwrap();
            let b = Path::new(b, platform).unwrap();
            assert_eq!(a.overlaps(&b), overlaps);
            assert_eq!(b.overlaps(&a), overlaps);
        }
        assert!(Path::new("relative", Platform::Posix).is_none());
        assert!(Path::new("C:relative", Platform::Windows).is_none());
        assert!(Path::new(r"\\server\share", Platform::Windows).is_none());
        assert!(Path::new("C:/work/file:stream", Platform::Windows).is_none());
        assert!(Path::new("C:/work. /file", Platform::Windows).is_none());
        assert!(Path::new("/bad\0path", Platform::Posix).is_none());
    }
}
