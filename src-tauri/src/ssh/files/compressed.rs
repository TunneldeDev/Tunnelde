use super::*;
use flate2::{write::ZlibEncoder, Compression, Decompress, FlushDecompress, Status};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

#[cfg(test)]
mod tests;

const LIMIT: usize = 1024 * 1024;
const SCRIPT: &str = include_str!("compressed.py");
const MAGIC: &[u8] = b"TUNNELDE-COMPRESSED-1\n";
type Response = AppResult<(Reply, Vec<u8>)>;
type Pending = Arc<Mutex<HashMap<u64, PendingReply>>>;

struct PendingReply {
    reply: oneshot::Sender<Response>,
    // Keep the slot until the wire acknowledgement, even if its caller cancels.
    _slot: OwnedSemaphorePermit,
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    size: usize,
    handle: Option<String>,
    length: Option<usize>,
    #[serde(default)]
    compressed: bool,
    error: Option<String>,
}

struct Request {
    id: u64,
    header: Value,
    data: Vec<u8>,
    reply: oneshot::Sender<Response>,
    slot: OwnedSemaphorePermit,
}

/// One bounded SSH stream, with independent writer/reader polling to pipeline
/// requests. Dropping it closes stdio and the remote worker's finally block.
pub(super) struct Session {
    requests: mpsc::Sender<Request>,
    next: AtomicU64,
    slots: Arc<Semaphore>,
    worker: tokio::task::JoinHandle<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

fn protocol_error() -> AppError {
    AppError::Ssh("sftp.compressionProtocol".into())
}

fn encode(bytes: Vec<u8>) -> AppResult<(Vec<u8>, bool)> {
    if bytes.len() < 4096 {
        return Ok((bytes, false));
    }
    let compress = |data: &[u8]| -> AppResult<Vec<u8>> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data)?;
        Ok(encoder.finish()?)
    };
    let sample = &bytes[..bytes.len().min(16384)];
    if compress(sample)?.len() * 10 >= sample.len() * 9 {
        return Ok((bytes, false));
    }
    let packed = compress(&bytes)?;
    if packed.len() * 10 < bytes.len() * 9 {
        Ok((packed, true))
    } else {
        Ok((bytes, false))
    }
}

fn decode(bytes: Vec<u8>, length: usize, compressed: bool) -> AppResult<Vec<u8>> {
    if length > LIMIT {
        return Err(protocol_error());
    }
    if !compressed {
        return if bytes.len() == length {
            Ok(bytes)
        } else {
            Err(protocol_error())
        };
    }
    let mut decoder = Decompress::new(true);
    let mut output = vec![0; length + 1];
    let status = decoder
        .decompress(&bytes, &mut output, FlushDecompress::Finish)
        .map_err(|_| protocol_error())?;
    if status != Status::StreamEnd
        || decoder.total_out() as usize != length
        || decoder.total_in() as usize != bytes.len()
    {
        return Err(protocol_error());
    }
    output.truncate(length);
    Ok(output)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Select the optional transport before opening it. Incompressible tasks retain
/// the native SFTP pipeline instead of paying for a Python data relay.
pub(super) async fn worthwhile(
    source: &Endpoint,
    sftp: Option<&SftpSession>,
    channel: Option<&super::range_io::DataSession>,
) -> AppResult<bool> {
    let before = source_stamp(source, sftp).await?;
    let width = before.0.min(16384);
    if width < 4096 {
        return Ok(false);
    }
    let mut local = if source.session.is_none() {
        Some(tokio::fs::File::open(&source.path).await?)
    } else {
        None
    };
    let remote = if source.session.is_some() {
        Some(
            super::range_io::SampleReader::open(
                channel.ok_or_else(|| AppError::internal("sftp.channel"))?,
                &source.path,
            )
            .await?,
        )
    } else {
        None
    };
    let sampled = async {
        // Explicit-offset SFTP reads avoid AsyncRead's larger speculative reads.
        // At most three 16 KiB regions; reject on the first unhelpful region.
        let tail = before.0 - width;
        let mut offsets = vec![0, tail / 2, tail];
        offsets.sort_unstable();
        offsets.dedup();
        for offset in offsets {
            let bytes = if let Some(remote) = &remote {
                remote.region(offset, width as usize).await?
            } else {
                let local = local.as_mut().expect("local sample source");
                local.seek(std::io::SeekFrom::Start(offset)).await?;
                let mut bytes = vec![0; width as usize];
                local.read_exact(&mut bytes).await?;
                bytes
            };
            let helpful = tokio::task::spawn_blocking(move || {
                encode(bytes).map(|(_, compressed)| compressed)
            })
            .await
            .map_err(|_| protocol_error())??;
            if !helpful {
                return Ok(false);
            }
        }
        if source_stamp(source, sftp).await? != before {
            return Err(AppError::validation("sftp.resumeSourceChanged"));
        }
        Ok(true)
    }
    .await;
    let closed = if let Some(remote) = remote {
        remote.finish().await
    } else {
        Ok(())
    };
    sampled.and_then(|worth| closed.map(|_| worth))
}

impl Session {
    pub async fn read_archive(
        &self,
        entries: Vec<super::archive::Entry>,
        compression: bool,
    ) -> AppResult<Vec<Vec<u8>>> {
        let lengths: Vec<_> = entries.iter().map(|entry| entry.length).collect();
        let (reply, data) = self
            .request(
                json!({"op":"archive_read","entries":entries,"compression":compression}),
                Vec::new(),
            )
            .await?;
        let length = reply.length.ok_or_else(protocol_error)?;
        tokio::task::spawn_blocking(move || {
            super::archive::unpack(decode(data, length, reply.compressed)?, &lengths)
        })
        .await
        .map_err(|_| protocol_error())?
    }

    pub async fn write_archive(
        &self,
        entries: Vec<super::archive::Entry>,
        files: Vec<Vec<u8>>,
        compression: bool,
    ) -> AppResult<()> {
        let (data, length, compressed) = tokio::task::spawn_blocking(move || {
            let archive = super::archive::pack(files)?;
            let length = archive.len();
            let (data, compressed) = if compression {
                encode(archive)?
            } else {
                (archive, false)
            };
            Ok::<_, AppError>((data, length, compressed))
        })
        .await
        .map_err(|_| protocol_error())??;
        let (reply, _) = self.request(
            json!({"op":"archive_write","entries":entries,"length":length,"compressed":compressed}),
            data,
        ).await?;
        if reply.size != 0 {
            return Err(protocol_error());
        }
        Ok(())
    }

    /// End an interrupted read-only channel without waiting for a peer reply.
    /// Callers must still await CLOSE before treating remote writes as settled.
    pub fn abort(&self) {
        self.worker.abort();
    }

    pub(super) fn command(home: &str) -> String {
        format!("python3 -I -S -u -c {} {}", quote(SCRIPT), quote(home))
    }

    pub async fn connect(app: &AppHandle, id: &str, sftp: &SftpSession) -> AppResult<Self> {
        // An SFTP-only/chrooted filesystem may use different absolute paths.
        // Enable exec transport only when both sides resolve the same home.
        let home = sftp.canonicalize(".").await.map_err(map_sftp)?;
        let channel = app
            .state::<AppState>()
            .ssh
            .handle(id)?
            .channel_open_session()
            .await
            .map_err(|_| protocol_error())?;
        channel
            .exec(true, Self::command(&home))
            .await
            .map_err(|_| protocol_error())?;
        Self::new(channel.into_stream()).await
    }

    pub(super) async fn new(
        stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    ) -> AppResult<Self> {
        let (input, mut output) = tokio::io::split(stream);
        let mut input = BufReader::new(input);
        let mut magic = vec![0; MAGIC.len()];
        input.read_exact(&mut magic).await?;
        if magic != MAGIC {
            return Err(protocol_error());
        }
        let (requests, mut receiver) = mpsc::channel::<Request>(64);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let worker = tokio::spawn(async move {
            let write = async {
                while let Some(request) = receiver.recv().await {
                    if request.reply.is_closed() {
                        continue;
                    }
                    let bytes = serde_json::to_vec(&request.header)?;
                    if bytes.len() > 16383 {
                        return Err(protocol_error());
                    }
                    pending.lock().unwrap().insert(
                        request.id,
                        PendingReply {
                            reply: request.reply,
                            _slot: request.slot,
                        },
                    );
                    output.write_all(&bytes).await?;
                    output.write_all(b"\n").await?;
                    output.write_all(&request.data).await?;
                    output.flush().await?;
                }
                Err::<(), AppError>(protocol_error())
            };
            let read = async {
                loop {
                    let mut header = Vec::new();
                    (&mut input)
                        .take(16385)
                        .read_until(b'\n', &mut header)
                        .await?;
                    if header.len() > 16384 || !header.ends_with(b"\n") {
                        return Err(protocol_error());
                    }
                    let reply: Reply =
                        serde_json::from_slice(&header).map_err(|_| protocol_error())?;
                    if reply.size > LIMIT {
                        return Err(protocol_error());
                    }
                    let mut data = vec![0; reply.size];
                    input.read_exact(&mut data).await?;
                    let sender = pending
                        .lock()
                        .unwrap()
                        .remove(&reply.id)
                        .ok_or_else(protocol_error)?;
                    let _ = sender.reply.send(Ok((reply, data)));
                }
                #[allow(unreachable_code)]
                Ok::<(), AppError>(())
            };
            let error = tokio::try_join!(write, read)
                .err()
                .unwrap_or_else(protocol_error)
                .to_string();
            for (_, sender) in pending.lock().unwrap().drain() {
                let _ = sender.reply.send(Err(AppError::Ssh(error.clone())));
            }
        });
        Ok(Self {
            requests,
            next: AtomicU64::new(1),
            slots: Arc::new(Semaphore::new(64)),
            worker,
        })
    }

    async fn exchange(&self, mut header: Value, data: Vec<u8>) -> Response {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        header["id"] = id.into();
        header["size"] = data.len().into();
        let wait = async {
            let slot = self
                .slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| protocol_error())?;
            let (reply, result) = oneshot::channel();
            self.requests
                .send(Request {
                    id,
                    header,
                    data,
                    reply,
                    slot,
                })
                .await
                .map_err(|_| protocol_error())?;
            result.await.map_err(|_| protocol_error())?
        };
        let result = match tokio::time::timeout(std::time::Duration::from_secs(30), wait).await {
            Ok(result) => result?,
            Err(_) => {
                // The stream cannot safely be reused after an unacknowledged write.
                self.worker.abort();
                return Err(AppError::Ssh("sftp.transferTimedOut".into()));
            }
        };
        Ok(result)
    }

    async fn request(&self, header: Value, data: Vec<u8>) -> Response {
        let result = self.exchange(header, data).await?;
        if let Some(error) = &result.0.error {
            tracing::debug!(%error, "Compressed transfer worker rejected a request");
            return Err(AppError::Ssh("sftp.compressionWorker".into()));
        }
        Ok(result)
    }

    pub(super) async fn create_private_directory(
        &self,
        path: &str,
    ) -> AppResult<range_io::DirectoryCreation> {
        let (reply, _) = self
            .exchange(json!({"op":"mkdir_private","path":path}), Vec::new())
            .await?;
        if reply.size != 0 {
            return Err(protocol_error());
        }
        if let Some(error) = reply.error {
            tracing::debug!(%error, "Compressed transfer worker rejected directory creation");
            return Ok(range_io::DirectoryCreation::Rejected(AppError::Ssh(
                "sftp.compressionWorker".into(),
            )));
        }
        Ok(range_io::DirectoryCreation::Created)
    }

    pub async fn open(&self, path: &str, write: bool) -> AppResult<String> {
        self.request(json!({"op":"open","path":path,"write":write}), Vec::new())
            .await?
            .0
            .handle
            .ok_or_else(protocol_error)
    }
    pub async fn close(&self, handle: &str) -> AppResult<()> {
        let (reply, _) = self
            .request(json!({"op":"close","handle":handle}), Vec::new())
            .await?;
        if reply.size != 0 {
            return Err(protocol_error());
        }
        Ok(())
    }
    pub async fn read(&self, handle: &str, offset: u64, length: usize) -> AppResult<Vec<u8>> {
        if length == 0 || length > LIMIT {
            return Err(protocol_error());
        }
        let (reply, data) = self
            .request(
                json!({"op":"read","handle":handle,"offset":offset,"length":length}),
                Vec::new(),
            )
            .await?;
        let size = reply.length.ok_or_else(protocol_error)?;
        if size > length {
            return Err(protocol_error());
        }
        tokio::task::spawn_blocking(move || decode(data, size, reply.compressed))
            .await
            .map_err(|_| protocol_error())?
    }
    pub async fn write(&self, handle: &str, offset: u64, data: Vec<u8>) -> AppResult<()> {
        let length = data.len();
        if length == 0 || length > LIMIT {
            return Err(protocol_error());
        }
        let (data, compressed) = tokio::task::spawn_blocking(move || encode(data))
            .await
            .map_err(|_| protocol_error())??;
        let (reply, _) = self.request(json!({"op":"write","handle":handle,"offset":offset,"length":length,"compressed":compressed}), data).await?;
        if reply.size != 0 {
            return Err(protocol_error());
        }
        Ok(())
    }
}
