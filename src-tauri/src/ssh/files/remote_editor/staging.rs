//! Serialized raw staging writes preserve terminal replies without lossy IO errors.
use super::*;
use russh_sftp::protocol::FileAttributes;

pub(super) async fn exclusive_write(
    replacement: &remote_commit::Replacement,
    record: &mut Record,
    checkpoint: &impl Fn(&Record) -> AppResult<()>,
    path: &str,
    content: &[u8],
) -> AppResult<()> {
    let raw = replacement.raw();
    let handle = recovery::mutation(
        record,
        checkpoint,
        raw.open(
            path,
            OpenFlags::READ | OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        ),
    )
    .await?
    .handle;
    let result: AppResult<()> = async {
        let chunk_size = replacement.write_chunk(&handle)?;
        for (index, chunk) in content.chunks(chunk_size).enumerate() {
            recovery::mutation(
                record,
                checkpoint,
                raw.write(&handle, (index * chunk_size) as u64, chunk.to_vec()),
            )
            .await?;
        }
        if replacement.supports_fsync() {
            recovery::mutation(record, checkpoint, raw.fsync(&handle)).await?;
        }
        Ok(())
    }
    .await;
    // Do not issue another mutation if a prior response remains unknown. Closing
    // the private channel retires handles without claiming its server work ended.
    if recovery::require_settled(record).is_ok() {
        let closed = recovery::mutation(record, checkpoint, raw.close(handle)).await;
        result?;
        closed?;
    } else {
        result?;
    }
    Ok(())
}
