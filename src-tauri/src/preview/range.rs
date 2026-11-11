pub const MAX_RANGE: u64 = 1024 * 1024;
pub const MAX_WHOLE: u64 = crate::services::files::read::MAX_READ_BYTES;

#[derive(Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub len: u64,
    pub partial: bool,
}

/// Like the Tauri asset handler, bound a single range even for open-ended media requests.
pub fn resolve(header: Option<&str>, size: u64) -> Option<ByteRange> {
    let Some(header) = header else {
        return (size <= MAX_WHOLE).then_some(ByteRange {
            start: 0,
            len: size,
            partial: false,
        });
    };
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 || end.contains('-') || end.contains(',') || start.contains(',') {
        return None;
    }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return None;
    }
    Some(ByteRange {
        start,
        len: (end - start + 1).min(MAX_RANGE),
        partial: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_media_suffix_open_ranges_and_empty_files_without_unbounded_reads() {
        assert_eq!(
            resolve(Some("bytes=0-"), 10_000_000).unwrap().len,
            MAX_RANGE
        );
        assert_eq!(resolve(Some("bytes=-20"), 100).unwrap().start, 80);
        assert_eq!(resolve(Some("bytes=90-999"), 100).unwrap().len, 10);
        assert_eq!(resolve(None, 0).unwrap().len, 0);
        assert!(resolve(None, MAX_WHOLE + 1).is_none());
        for range in [
            "bytes=100-",
            "bytes=5-4",
            "bytes=-0",
            "bytes=0-1,3-5",
            "bytes=0-18446744073709551616",
            "items=0-1",
        ] {
            assert!(resolve(Some(range), 100).is_none(), "{range}");
        }
    }
}
