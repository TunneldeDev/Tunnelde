use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use russh_sftp::client::{rawsession::Limits, RawSftpSession};
use std::ops::Range;
use std::sync::atomic::AtomicU64;

mod local_io;
mod observation;
use super::native_save::runtime::{terminal_mutation_status, MutationObservation};
use observation::Handle;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod protocol_tests;

/// Dedicated data channels keep explicit-offset requests separate from metadata
/// operations. Unlike AsyncRead prefetch, these never read past a segment boundary.
pub(super) struct DataSession {
    backend: Backend,
    read_size: usize,
    write_size: usize,
    copy_data: bool,
    writes: observation::Writes,
}

enum Backend {
    Sftp(Arc<RawSftpSession>),
    Compressed(super::compressed::Session),
}

/// Sampling happens before this source channel is shared with any writers.
/// If OPEN/READ/CLOSE is interrupted, close the whole channel, including handles
/// whose OPEN acknowledgement has not arrived yet. A failed sample is discarded.
pub(super) struct SampleReader<'a> {
    session: &'a DataSession,
    handle: Option<Handle>,
    finished: bool,
}

impl Drop for SampleReader<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.session.stop_reading();
        }
    }
}

impl<'a> SampleReader<'a> {
    pub(super) async fn open(session: &'a DataSession, path: &str) -> AppResult<Self> {
        let mut reader = Self {
            session,
            handle: None,
            finished: false,
        };
        reader.handle = Some(session.open(path, false).await?);
        Ok(reader)
    }

    pub(super) async fn region(&self, offset: u64, length: usize) -> AppResult<Vec<u8>> {
        let mut bytes = Vec::with_capacity(length);
        while bytes.len() < length {
            let remaining = length - bytes.len();
            let requested = remaining.min(self.session.read_size);
            let chunk = self
                .session
                .read(
                    self.handle.as_deref().expect("sampling handle"),
                    offset + bytes.len() as u64,
                    requested,
                )
                .await?;
            if chunk.is_empty() || chunk.len() > requested {
                return Err(AppError::validation("sftp.resumeSourceChanged"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub(super) async fn finish(mut self) -> AppResult<()> {
        self.session
            .close(self.handle.as_ref().expect("sampling handle"))
            .await?;
        self.finished = true;
        Ok(())
    }
}

/// A server rejection is a terminal reply; a transport error is not.
#[derive(Debug)]
pub(super) enum DirectoryCreation {
    Created,
    Rejected(AppError),
}

impl DirectoryCreation {
    pub(super) fn into_result(self) -> AppResult<()> {
        match self {
            Self::Created => Ok(()),
            Self::Rejected(error) => Err(error),
        }
    }
}

impl DataSession {
    /// Set private permissions in MKDIR itself; a separate chmod leaves a crash
    /// window and cannot safely distinguish an interrupted create on restart.
    pub(super) async fn create_private_directory(
        &self,
        path: &str,
    ) -> AppResult<DirectoryCreation> {
        match &self.backend {
            Backend::Sftp(raw) => {
                let raw = raw.clone();
                let path = path.to_owned();
                match self
                    .writes
                    .request(async move {
                        raw.mkdir(
                            path,
                            russh_sftp::protocol::FileAttributes {
                                permissions: Some(0o700),
                                ..Default::default()
                            },
                        )
                        .await
                    })
                    .await
                {
                    Ok(_) => Ok(DirectoryCreation::Created),
                    Err(russh_sftp::client::error::Error::Status(status))
                        if terminal_mutation_status(&status) =>
                    {
                        Ok(DirectoryCreation::Rejected(map_sftp(
                            russh_sftp::client::error::Error::Status(status),
                        )))
                    }
                    Err(error) => Err(map_sftp(error)),
                }
            }
            Backend::Compressed(worker) => worker.create_private_directory(path).await,
        }
    }

    #[cfg(test)]
    pub async fn new(
        stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    ) -> AppResult<Self> {
        Self::new_observed(stream, MutationObservation::default()).await
    }

    async fn new_observed(
        stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
        observation: MutationObservation,
    ) -> AppResult<Self> {
        let mut raw = RawSftpSession::new_with_config(
            stream,
            russh_sftp::client::Config {
                request_timeout_secs: 30,
                ..Default::default()
            },
        );
        let version = raw.init().await.map_err(map_sftp)?;
        let limits = if version
            .extensions
            .get("limits@openssh.com")
            .is_some_and(|v| v == "1")
        {
            Limits::from(raw.limits().await.map_err(map_sftp)?)
        } else {
            Limits::default()
        };
        let packet = limits.packet_len.unwrap_or(262144).min(262144);
        let read_size = limits
            .read_len
            .unwrap_or(262131)
            .min(262131)
            .min(packet.saturating_sub(13))
            .max(1) as usize;
        // Use the server's advertised payload budget. Falling back to 32 KiB
        // preserves compatibility with servers without limits@openssh.com.
        let write_size = limits
            .write_len
            .unwrap_or(32768)
            .min(262144)
            .min(packet.saturating_sub(1024))
            .max(1) as usize;
        raw.set_limits(limits);
        Ok(Self {
            backend: Backend::Sftp(Arc::new(raw)),
            writes: observation::Writes::new(observation),
            read_size,
            write_size,
            copy_data: version
                .extensions
                .get("copy-data")
                .is_some_and(|v| v == "1"),
        })
    }

    async fn connect(
        app: &AppHandle,
        session: &str,
        compress: bool,
        sftp: &SftpSession,
        observation: MutationObservation,
    ) -> AppResult<Self> {
        if compress {
            if let Ok(Ok(worker)) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                super::compressed::Session::connect(app, session, sftp, observation.clone()),
            )
            .await
            {
                tracing::debug!("Using adaptive compressed SSH transfer channel");
                return Ok(Self {
                    backend: Backend::Compressed(worker),
                    read_size: 256 * 1024,
                    write_size: 256 * 1024,
                    copy_data: false,
                    writes: observation::Writes::new(observation),
                });
            }
            tracing::debug!("Compression worker unavailable; using SFTP data channel");
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let channel = app
                .state::<AppState>()
                .ssh
                .handle(session)?
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(format!("sftp.channel: {e}")))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| AppError::Ssh(format!("sftp.subsystem: {e}")))?;
            Self::new_observed(channel.into_stream(), observation).await
        })
        .await
        .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?
    }

    async fn open(&self, path: &str, write: bool) -> AppResult<Handle> {
        match &self.backend {
            Backend::Compressed(worker) => worker.open(path, write).await.map(Handle::unowned),
            Backend::Sftp(raw) if write => self.writes.open(raw.clone(), path.to_owned()).await,
            Backend::Sftp(raw) => Ok(Handle::unowned(
                raw.open(
                    path,
                    OpenFlags::READ,
                    russh_sftp::protocol::FileAttributes::empty(),
                )
                .await
                .map_err(map_sftp)?
                .handle,
            )),
        }
    }
    async fn close(&self, handle: &Handle) -> AppResult<()> {
        match &self.backend {
            Backend::Compressed(worker) => worker.close(handle).await,
            Backend::Sftp(raw) => handle.close(raw.clone()).await,
        }
    }

    /// Only for an interrupted source channel. It owns no destination writers,
    /// so a missing read/CLOSE acknowledgement cannot block local file cleanup.
    fn stop_reading(&self) -> AppResult<()> {
        match &self.backend {
            Backend::Sftp(raw) => raw.close_session().map_err(map_sftp),
            Backend::Compressed(worker) => {
                worker.abort();
                Ok(())
            }
        }
    }
    async fn read(&self, handle: &str, offset: u64, length: usize) -> AppResult<Vec<u8>> {
        match &self.backend {
            Backend::Compressed(worker) => worker.read(handle, offset, length).await,
            Backend::Sftp(raw) => Ok(raw
                .read(handle, offset, length as u32)
                .await
                .map_err(map_sftp)?
                .data),
        }
    }
    async fn write(&self, handle: &str, offset: u64, data: Vec<u8>) -> AppResult<()> {
        match &self.backend {
            Backend::Compressed(worker) => worker.write(handle, offset, data).await,
            Backend::Sftp(raw) => {
                let raw = raw.clone();
                let handle = handle.to_owned();
                self.writes
                    .request(async move { raw.write(handle, offset, data).await })
                    .await
                    .map_err(map_sftp)?;
                Ok(())
            }
        }
    }

    async fn copy_range(
        &self,
        source: &str,
        target: &str,
        offset: u64,
        length: usize,
    ) -> AppResult<()> {
        use russh_sftp::protocol::Packet;
        let Backend::Sftp(raw) = &self.backend else {
            return Err(AppError::internal("sftp.copyDataUnavailable"));
        };
        if !self.copy_data || length == 0 || length > 1024 * 1024 {
            return Err(AppError::internal("sftp.copyDataRange"));
        }
        let mut data = Vec::new();
        data.extend_from_slice(&(source.len() as u32).to_be_bytes());
        data.extend_from_slice(source.as_bytes());
        data.extend_from_slice(&offset.to_be_bytes());
        data.extend_from_slice(&(length as u64).to_be_bytes());
        data.extend_from_slice(&(target.len() as u32).to_be_bytes());
        data.extend_from_slice(target.as_bytes());
        data.extend_from_slice(&offset.to_be_bytes());
        let raw = raw.clone();
        self.writes
            .request(async move {
                match raw.extended("copy-data", data).await? {
                    Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
                    Packet::Status(status) => Err(russh_sftp::client::error::Error::Status(status)),
                    _ => Err(russh_sftp::client::error::Error::UnexpectedPacket),
                }
            })
            .await
            .map_err(map_sftp)
    }
}

#[derive(Clone, Default)]
pub(super) struct Sessions {
    pub source: Option<Arc<DataSession>>,
    pub target: Option<Arc<DataSession>>,
}

pub(super) struct Plan<'a> {
    pub settings: &'a crate::settings::Settings,
    pub total_size: u64,
    pub observation: MutationObservation,
}

impl Sessions {
    pub(super) fn server_copy(&self) -> bool {
        matches!((&self.source, &self.target), (Some(source), Some(target))
            if source.copy_data && Arc::ptr_eq(source, target))
    }
    pub async fn open(
        app: &AppHandle,
        source: &Endpoint,
        target: &Endpoint,
        plan: Plan<'_>,
        source_sftp: Option<&SftpSession>,
        target_sftp: Option<&SftpSession>,
    ) -> AppResult<Self> {
        let Plan {
            settings,
            total_size,
            observation,
        } = plan;
        // SFTP handles only belong to their channel. Share one negotiated data
        // channel for a same-session server copy; never infer identity by address.
        let mut candidate = if settings.transfer_optimization
            && source.session.is_some()
            && source.session == target.session
        {
            let channel = Arc::new(
                DataSession::connect(
                    app,
                    source.session.as_deref().expect("remote source"),
                    false,
                    source_sftp.ok_or_else(|| AppError::internal("sftp.channel"))?,
                    observation.clone(),
                )
                .await?,
            );
            if channel.copy_data {
                tracing::debug!("Using server-side SFTP copy-data transfer channel");
                return Ok(Self {
                    source: Some(channel.clone()),
                    target: Some(channel),
                });
            }
            Some(channel)
        } else {
            None
        };
        // Directory tasks share the channel and use their combined payload size.
        // Tiny standalone transfers avoid the helper startup entirely.
        let enabled = settings.transfer_optimization
            && settings.transfer_compression
            && total_size >= 256 * 1024;
        if enabled && source.session.is_some() && candidate.is_none() {
            candidate = Some(Arc::new(
                DataSession::connect(
                    app,
                    source.session.as_deref().expect("remote source"),
                    false,
                    source_sftp.ok_or_else(|| AppError::internal("sftp.channel"))?,
                    observation.clone(),
                )
                .await?,
            ));
        }
        let compress = if enabled {
            match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                super::compressed::worthwhile(source, source_sftp, candidate.as_deref()),
            )
            .await
            {
                Ok(Ok(helpful)) => helpful,
                _ => {
                    // Cancellation may close a read-only sampling channel.
                    // Never reuse it after a failed or timed-out probe.
                    candidate = None;
                    false
                }
            }
        } else {
            false
        };
        let source = match (&source.session, candidate.filter(|_| !compress)) {
            (_, Some(channel)) => Some(channel),
            (Some(id), None) => Some(Arc::new(
                DataSession::connect(
                    app,
                    id,
                    compress,
                    source_sftp.ok_or_else(|| AppError::internal("sftp.channel"))?,
                    observation.clone(),
                )
                .await?,
            )),
            (None, None) => None,
        };
        let target = match &target.session {
            Some(id) => Some(Arc::new(
                DataSession::connect(
                    app,
                    id,
                    compress,
                    target_sftp.ok_or_else(|| AppError::internal("sftp.channel"))?,
                    observation,
                )
                .await?,
            )),
            None => None,
        };
        Ok(Self { source, target })
    }
}

pub(super) struct Files<'a> {
    sessions: &'a Sessions,
    source: &'a Endpoint,
    target: &'a Endpoint,
    source_handle: Option<Handle>,
    target_handle: Option<Handle>,
    throttle: Option<bandwidth::Throttle>,
    unsettled_write: AtomicBool,
    observation: MutationObservation,
}

/// A dropped request may still run on the server. Drain its handle before
/// retiring a task; recovery must replay its entire journalled write window.
struct WriteAttempt<'a> {
    unsettled: &'a AtomicBool,
    acknowledged: bool,
}

impl Drop for WriteAttempt<'_> {
    fn drop(&mut self) {
        if !self.acknowledged {
            self.unsettled.store(true, Ordering::SeqCst);
        }
    }
}

async fn close_handle(session: &Option<Arc<DataSession>>, handle: Option<Handle>) -> AppResult<()> {
    if let (Some(session), Some(handle)) = (session, handle) {
        tokio::time::timeout(std::time::Duration::from_secs(5), session.close(&handle))
            .await
            .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))??;
    }
    Ok(())
}

async fn complete_packet(
    result: AppResult<(u64, Vec<u8>, usize)>,
    writer: &mut Option<local_io::Writer>,
    transferred: &AtomicU64,
    observation: &MutationObservation,
) -> AppResult<()> {
    let (offset, bytes, length) = result?;
    if let Some(writer) = writer {
        observation.authorize()?;
        writer.write(offset, &bytes).await?;
    }
    transferred.fetch_add(length as u64, Ordering::Relaxed);
    Ok(())
}

impl<'a> Files<'a> {
    fn server_copy(&self) -> Option<&DataSession> {
        let source = self.sessions.source.as_ref()?;
        (self.sessions.server_copy()
            && self.source.session.is_some()
            && self.source.session == self.target.session)
            .then_some(source.as_ref())
    }
    pub async fn open(
        sessions: &'a Sessions,
        source: &'a Endpoint,
        target: &'a Endpoint,
    ) -> AppResult<Self> {
        Self::open_inner(sessions, source, target, None).await
    }

    pub async fn open_cancellable(
        sessions: &'a Sessions,
        source: &'a Endpoint,
        target: &'a Endpoint,
        cancel: &AtomicBool,
    ) -> AppResult<Self> {
        Self::open_inner(sessions, source, target, Some(cancel)).await
    }

    async fn open_inner(
        sessions: &'a Sessions,
        source: &'a Endpoint,
        target: &'a Endpoint,
        cancel: Option<&AtomicBool>,
    ) -> AppResult<Self> {
        // Data opens never create, truncate or write: cancelling an unacknowledged
        // open is safe. The task drops its shared channel after writers drain.
        let source_handle = match &sessions.source {
            Some(session) => Some(interruptible(cancel, session.open(&source.path, false)).await?),
            None => None,
        };
        let target_handle = match &sessions.target {
            Some(session) => match interruptible(cancel, session.open(&target.path, true)).await {
                Ok(handle) => Some(handle),
                Err(error) => {
                    // No writes have started. Do not hold up cancellation for
                    // a read handle's CLOSE or abort other shared-channel users.
                    let _ =
                        interruptible(cancel, close_handle(&sessions.source, source_handle)).await;
                    return Err(error);
                }
            },
            None => None,
        };
        Ok(Self {
            sessions,
            source,
            target,
            source_handle,
            target_handle,
            throttle: None,
            unsettled_write: AtomicBool::new(false),
            observation: MutationObservation::default(),
        })
    }

    pub fn with_throttle(mut self, throttle: bandwidth::Throttle) -> Self {
        self.throttle = Some(throttle);
        self
    }

    pub(super) fn with_observation(mut self, observation: MutationObservation) -> Self {
        self.observation = observation;
        self
    }

    pub async fn finish_cancellable(self, interrupted: bool, cancel: &AtomicBool) -> AppResult<()> {
        if self.target_handle.is_some() || self.unsettled_write.load(Ordering::SeqCst) {
            // A writable OPEN remains owned until its original CLOSE replies,
            // including when every WRITE acknowledged or cancellation happened
            // between packets. Skipping CLOSE would make an orderly pause
            // permanently unknown. Each handle drain has its own five-second
            // bound; cancellation stops new data, not original completion.
            self.finish(interrupted).await
        } else {
            // Read-only source completion does not hold remote write authority.
            interruptible(Some(cancel), self.finish(interrupted)).await
        }
    }

    pub async fn finish(self, interrupted: bool) -> AppResult<()> {
        // Source and destination normally use separate channels, even on the
        // same SSH host. Never abort a channel that also owns a remote writer.
        let interrupted_source = self.sessions.source.as_ref().filter(|source| {
            interrupted
                && !self
                    .sessions
                    .target
                    .as_ref()
                    .is_some_and(|target| Arc::ptr_eq(source, target))
        });
        if let Some(source) = interrupted_source {
            let stopped = source.stop_reading();
            let target = close_handle(&self.sessions.target, self.target_handle).await;
            return stopped.and(target);
        }
        let (source, target) = tokio::join!(
            close_handle(&self.sessions.source, self.source_handle),
            close_handle(&self.sessions.target, self.target_handle)
        );
        source.and(target)
    }

    async fn packet(
        &self,
        offset: u64,
        length: usize,
        input: Option<Vec<u8>>,
        stop: &AtomicBool,
    ) -> AppResult<(u64, Vec<u8>, usize)> {
        if let Some(session) = self.server_copy() {
            let mut attempt = WriteAttempt {
                unsettled: &self.unsettled_write,
                acknowledged: false,
            };
            interruptible(Some(stop), async {
                session
                    .copy_range(
                        self.source_handle.as_deref().expect("source handle"),
                        self.target_handle.as_deref().expect("target handle"),
                        offset,
                        length,
                    )
                    .await
            })
            .await?;
            attempt.acknowledged = true;
            return Ok((offset, Vec::new(), length));
        }
        let data = if let Some(data) = input {
            data
        } else {
            let session = self.sessions.source.as_ref().expect("remote source");
            let handle = self.source_handle.as_deref().expect("source handle");
            let mut data = Vec::with_capacity(length);
            while data.len() < length {
                let size = (length - data.len()).min(session.read_size);
                let reply = interruptible(Some(stop), async {
                    session.read(handle, offset + data.len() as u64, size).await
                })
                .await?;
                if reply.is_empty() || reply.len() > size {
                    return Err(AppError::validation("sftp.resumeSourceChanged"));
                }
                data.extend_from_slice(&reply);
            }
            data
        };
        if let Some(session) = &self.sessions.target {
            let handle = self.target_handle.as_deref().expect("target handle");
            let mut written = 0;
            while written < data.len() {
                let size = (data.len() - written).min(session.write_size);
                let mut attempt = WriteAttempt {
                    unsettled: &self.unsettled_write,
                    acknowledged: false,
                };
                interruptible(Some(stop), async {
                    session
                        .write(
                            handle,
                            offset + written as u64,
                            data[written..written + size].to_vec(),
                        )
                        .await?;
                    Ok(())
                })
                .await?;
                attempt.acknowledged = true;
                written += size;
            }
        }
        let length = data.len();
        Ok((offset, data, length))
    }

    async fn prepare_packet(
        &self,
        reader: &mut Option<local_io::Reader>,
        length: usize,
        stop: &AtomicBool,
    ) -> AppResult<(usize, Option<Vec<u8>>)> {
        let direction = match (&self.sessions.source, &self.sessions.target) {
            // copy-data sends only control requests over SSH. Its file bytes
            // consume the task's disk-copy budget, never global network credit.
            (Some(_), Some(_)) if self.server_copy().is_some() => bandwidth::Direction::Local,
            (Some(_), Some(_)) => bandwidth::Direction::Both,
            (Some(_), None) => bandwidth::Direction::Download,
            (None, Some(_)) => bandwidth::Direction::Upload,
            (None, None) => bandwidth::Direction::Local,
        };
        let length = match &self.throttle {
            Some(throttle) => throttle.acquire(direction, length, stop).await?,
            None => length,
        };
        let input = match reader {
            Some(reader) => {
                let mut bytes = vec![0; length];
                interruptible(Some(stop), async {
                    reader.read_exact(&mut bytes).await?;
                    Ok(())
                })
                .await?;
                Some(bytes)
            }
            None => None,
        };
        Ok((length, input))
    }

    pub async fn segment(
        &self,
        range: Range<u64>,
        requests: usize,
        stop: &AtomicBool,
        transferred: &AtomicU64,
    ) -> AppResult<()> {
        self.observation.authorize()?;
        let mut reader = if self.sessions.source.is_none() {
            Some(local_io::reader(&self.source.path, &range).await?)
        } else {
            None
        };
        let mut writer = if self.sessions.target.is_none() {
            Some(local_io::Writer::open(&self.target.path).await?)
        } else {
            None
        };
        let mut pending = FuturesUnordered::new();
        let mut next = range.start;
        let mut error = None;
        while next < range.end || !pending.is_empty() {
            if next < range.end
                && pending.len() < requests
                && error.is_none()
                && !stop.load(Ordering::SeqCst)
            {
                // Each future should represent one wire request per endpoint.
                // A 64 KiB logical packet split into acknowledged 32 KiB writes
                // serializes its halves and underfills a high-latency pipeline.
                let packet_size = if self.server_copy().is_some() {
                    1024 * 1024
                } else {
                    match (&self.sessions.source, &self.sessions.target) {
                        (Some(source), Some(target)) => source.read_size.min(target.write_size),
                        (Some(source), None) => source.read_size,
                        (None, Some(target)) => target.write_size,
                        (None, None) => CHUNK,
                    }
                };
                let length = (range.end - next).min(packet_size as u64) as usize;
                let prepared = self.prepare_packet(&mut reader, length, stop);
                tokio::pin!(prepared);
                // Keep both the limiter and existing IO progressing. Keep this
                // preparation alive across completions: restarting it could lose
                // already granted credits or partially consumed local input.
                loop {
                    tokio::select! {
                        result = &mut prepared => {
                            match result {
                                Ok((length, input)) => {
                                    pending.push(self.packet(next, length, input, stop));
                                    next += length as u64;
                                }
                                Err(failure) => {
                                    error.get_or_insert(failure);
                                    stop.store(true, Ordering::SeqCst);
                                }
                            }
                            break;
                        }
                        Some(result) = pending.next(), if !pending.is_empty() => {
                            if let Err(failure) = complete_packet(result, &mut writer, transferred, &self.observation).await {
                                error.get_or_insert(failure);
                                stop.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                    }
                }
            } else if let Some(result) = pending.next().await {
                if let Err(failure) =
                    complete_packet(result, &mut writer, transferred, &self.observation).await
                {
                    error.get_or_insert(failure);
                    stop.store(true, Ordering::SeqCst);
                }
            } else {
                break;
            }
        }
        if let Some(writer) = &mut writer {
            if let Err(failure) = writer.flush().await {
                error.get_or_insert(failure);
            }
        }
        if stop.load(Ordering::SeqCst) {
            error.get_or_insert_with(|| AppError::Ssh(CANCELLED.into()));
        }
        error.map_or(Ok(()), Err)
    }
}
