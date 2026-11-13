//! Connect only captured endpoints, with explicit cleanup across every await.
mod snapshot;
use super::*;
pub(super) use snapshot::Snapshot;

pub(super) async fn open(
    app: &AppHandle,
    snapshot: &Snapshot,
    credentials: &HashMap<String, HopCredential>,
    probing: bool,
    destination: Option<&SessionIdentity>,
) -> AppResult<(
    PendingRoute,
    HostKeyInfo,
    Arc<super::super::forward::RemoteRoutes>,
)> {
    let target = &snapshot.nodes.last().expect("captured target").host;
    if let Some(destination) = destination {
        destination.verify_host(target)?;
    }
    let mut pending = PendingRoute::default();
    for (index, node) in snapshot.nodes.iter().enumerate() {
        snapshot.verify(app)?;
        let host = &node.host;
        let expected = if let Some(destination) = destination.filter(|_| host.id == target.id) {
            Some(destination.server_key.clone())
        } else if probing {
            None
        } else {
            Some(
                node.key
                    .clone()
                    .ok_or_else(|| AppError::Ssh(format!("ssh.hostKeyUntrusted: {}", host.name)))?,
            )
        };
        let stream = match pending.jumps.last() {
            Some(jump) => Box::pin(
                tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    jump.channel_open_direct_tcpip(&host.host, host.port as u32, "127.0.0.1", 0),
                )
                .await
                .map_err(|_| AppError::Ssh("ssh.timeout".into()))?
                .map_err(map_ssh_error)?
                .into_stream(),
            ) as crate::network::Stream,
            None => snapshot.transport.connect(&host.host, host.port).await?,
        };
        let (handle, observed, remote_forwards) = handshake(stream, expected).await?;
        pending.target = Some(handle);
        // No credentials are sent after a host, route, proxy or trust edit.
        // The sockets still use the snapshot even if an edit races this check.
        snapshot.verify(app)?;
        let status = match node.key.as_deref() {
            None => HostKeyStatus::Unknown,
            Some(key) if key == observed.fingerprint => HostKeyStatus::Known,
            Some(_) => HostKeyStatus::Changed,
        };
        let info = HostKeyInfo {
            host_id: host.id.clone(),
            fingerprint: observed.fingerprint,
            algorithm: observed.algorithm,
            status,
            known_fingerprint: node.key.clone(),
            connection_time_ms: None,
        };
        if probing && (status != HostKeyStatus::Known || index + 1 == snapshot.nodes.len()) {
            return Ok((pending, info, remote_forwards));
        }
        if status != HostKeyStatus::Known {
            return Err(AppError::Ssh(format!("ssh.hostKeyChanged: {}", host.name)));
        }
        if index + 1 == snapshot.nodes.len() {
            return Ok((pending, info, remote_forwards));
        }
        let credential = credentials.get(&host.id).cloned().unwrap_or_default();
        let request = SshConnectRequest {
            host_id: host.id.clone(),
            background: false,
            purpose: None,
            password: credential.password,
            passphrase: credential.passphrase,
            jump_credentials: HashMap::new(),
            cols: 120,
            rows: 32,
        };
        let request = snapshot.authentication(app, host, &request)?;
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            authenticate(
                pending.target.as_mut().expect("route target"),
                host,
                &request,
            ),
        )
        .await
        .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;
        snapshot.verify(app)?;
        pending
            .jumps
            .push(Arc::new(pending.target.take().expect("authenticated jump")));
    }
    Err(AppError::validation("network.invalid"))
}

pub(super) async fn probe(
    app: &AppHandle,
    snapshot: &Snapshot,
    credentials: &HashMap<String, HopCredential>,
    destination: Option<&SessionIdentity>,
) -> AppResult<HostKeyInfo> {
    let started = std::time::Instant::now();
    let (mut pending, mut info, _) = open(app, snapshot, credentials, true, destination).await?;
    info.connection_time_ms = Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
    close_transports(
        pending
            .target
            .iter()
            .chain(pending.jumps.iter().rev().map(Arc::as_ref)),
        None,
    )
    .await;
    pending.target.take();
    pending.jumps.clear();
    snapshot.verify(app)?;
    Ok(info)
}
