use super::*;
use tokio::io::{BufReader, BufWriter, Take};

// Bound read-ahead and delayed writes per segment independently of file size
// and user-selected chunks. Each file has at most eight segment workers.
const BUFFER_SIZE: usize = 1024 * 1024;

pub(super) type Reader = BufReader<Take<tokio::fs::File>>;

pub(super) async fn reader(path: &str, range: &Range<u64>) -> AppResult<Reader> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(range.start)).await?;
    let length = range.end.saturating_sub(range.start);
    Ok(BufReader::with_capacity(
        length.min(BUFFER_SIZE as u64).max(1) as usize,
        file.take(length),
    ))
}

pub(super) struct Writer {
    file: BufWriter<tokio::fs::File>,
    position: u64,
}

impl Writer {
    pub(super) async fn open(path: &str) -> AppResult<Self> {
        let file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
        Ok(Self {
            file: BufWriter::with_capacity(BUFFER_SIZE, file),
            position: 0,
        })
    }

    pub(super) async fn write(&mut self, offset: u64, bytes: &[u8]) -> AppResult<()> {
        // Adjacent replies need no seek or forced flush. Out-of-order replies
        // flush through AsyncSeek before changing the actual file position.
        if offset != self.position {
            self.file.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        self.file.write_all(bytes).await?;
        self.position = offset + bytes.len() as u64;
        Ok(())
    }

    pub(super) async fn flush(&mut self) -> AppResult<()> {
        // A durable window cannot commit until both buffering layers finish.
        self.file.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_ahead_never_crosses_a_segment_boundary() {
        let path = std::env::temp_dir().join(format!("tunnelde-reader-{}", uuid::Uuid::new_v4()));
        let bytes: Vec<_> = (0..2 * BUFFER_SIZE + 19).map(|n| (n % 251) as u8).collect();
        tokio::fs::write(&path, &bytes).await.unwrap();
        for range in [0..0, 7..31, 13..(BUFFER_SIZE + 17) as u64] {
            let mut reader = reader(&display_path(&path), &range).await.unwrap();
            let mut actual = Vec::new();
            reader.read_to_end(&mut actual).await.unwrap();
            assert_eq!(actual, bytes[range.start as usize..range.end as usize]);
            assert_eq!(
                reader
                    .into_inner()
                    .into_inner()
                    .stream_position()
                    .await
                    .unwrap(),
                range.end
            );
        }
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn buffered_offsets_preserve_prefix_suffix_and_out_of_order_replies() {
        let path = std::env::temp_dir().join(format!("tunnelde-writer-{}", uuid::Uuid::new_v4()));
        let mut expected = vec![255; 2 * BUFFER_SIZE + 31];
        tokio::fs::write(&path, &expected).await.unwrap();
        let mut writer = Writer::open(&display_path(&path)).await.unwrap();
        for (offset, length, value) in [
            (17, 8192, 1),
            (8209, 32768, 2),
            (99, 37, 3),
            (1_048_601, 8192, 4),
            (1_056_793, 1_040_384, 5),
        ] {
            writer.write(offset, &vec![value; length]).await.unwrap();
            expected[offset as usize..offset as usize + length].fill(value);
        }
        writer.flush().await.unwrap();
        drop(writer);
        assert_eq!(tokio::fs::read(&path).await.unwrap(), expected);
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn delayed_write_errors_are_returned_by_flush() {
        let path =
            std::env::temp_dir().join(format!("tunnelde-write-error-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"original").await.unwrap();
        let mut writer = Writer {
            file: BufWriter::with_capacity(
                BUFFER_SIZE,
                tokio::fs::File::open(&path).await.unwrap(),
            ),
            position: 0,
        };
        writer.write(0, b"buffered").await.unwrap();
        assert!(writer.flush().await.is_err());
        drop(writer);
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        tokio::fs::remove_file(path).await.unwrap();
    }
}
