use super::{
    contracts::{Batch, Request, MAX_SAFE},
    cursor::{digest, Position},
    projection,
};
use crate::error::{AppError, AppResult};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
const WINDOW: u64 = 256 * 1024;
const LINE: usize = 64 * 1024;

fn open(path: &Path) -> AppResult<(File, String)> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?
    };
    #[cfg(unix)]
    let file = File::from(
        rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(std::io::Error::from)?,
    );
    if !file.metadata()?.is_file() {
        return Err(AppError::validation("logs.read.unavailable"));
    }
    #[cfg(windows)]
    let identity = serde_json::to_vec(&crate::platform::guarded_file::identity(&file)?)?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        serde_json::to_vec(&(metadata.dev(), metadata.ino()))?
    };
    Ok((file, digest(&identity)))
}
fn anchor(file: &mut File, offset: u64) -> AppResult<String> {
    let size = offset.min(64);
    file.seek(SeekFrom::Start(offset - size))?;
    let mut bytes = vec![0; size as usize];
    file.read_exact(&mut bytes)?;
    Ok(digest(&bytes))
}

#[cfg(all(test, unix))]
#[test]
fn open_rejects_symlink_even_after_selection() {
    let dir = std::env::temp_dir().join(format!("tunnelde-log-open-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("target");
    std::fs::write(&target, "private").unwrap();
    let link = dir.join("link");
    std::os::unix::fs::symlink(target, &link).unwrap();
    assert!(open(&link).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}
pub(super) fn read(
    dir: &Path,
    request: &Request,
    position: &mut Position,
    batch: &mut Batch,
    check: &impl Fn() -> AppResult<()>,
) -> AppResult<(bool, bool)> {
    check()?;
    let Some(name) = crate::logs::latest_name(dir)? else {
        let reset = position.file.is_some();
        batch.gap |= reset;
        *position = Position::default();
        return Ok((false, reset));
    };
    let (mut file, identity) = open(&dir.join(name))?;
    let length = file.metadata()?.len();
    if length > MAX_SAFE {
        return Err(AppError::validation("logs.read.unavailable"));
    }
    let initial = position.file.is_none();
    let reset = !initial
        && (position.file.as_ref() != Some(&identity)
            || position.offset > length
            || anchor(&mut file, position.offset)? != position.anchor);
    if initial || reset {
        position.file = Some(identity);
        position.offset = length.saturating_sub(WINDOW);
        position.discarding = position.offset != 0;
        batch.gap |= reset || position.discarding;
    }
    file.seek(SeekFrom::Start(position.offset))?;
    let mut bytes = Vec::new();
    (&mut file).take(WINDOW).read_to_end(&mut bytes)?;
    check()?;
    let start = position.offset;
    let mut index = 0;
    let mut full = false;
    let mut scanned = 0;
    while index < bytes.len() {
        if scanned == 2048 {
            full = true;
            break;
        }
        scanned += 1;
        check()?;
        let Some(end) = bytes[index..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| index + n + 1)
        else {
            if position.discarding || bytes.len() - index > LINE {
                position.offset = start + bytes.len() as u64;
                position.discarding = true;
                batch.gap = true;
            }
            break;
        };
        if position.discarding || end - index > LINE {
            batch.gap = true;
        } else if let Some(entry) = projection::diagnostic(&bytes[index..end]) {
            if request.filter.matches(&entry) && !batch.push(entry, request) {
                full = true;
                break; // Do not consume the first undelivered matching record.
            }
        } else {
            batch.gap = true;
        }
        position.discarding = false;
        position.offset = start + end as u64;
        index = end;
    }
    position.anchor = anchor(&mut file, position.offset)?;
    // A trailing partial line must wait for an append, not cause a tight drain loop.
    let more = full || start + (bytes.len() as u64) < length;
    check()?;
    Ok((more, reset))
}
