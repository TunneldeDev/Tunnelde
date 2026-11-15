//! Bridge the authenticated subsystem and the mount process's separate pipes.
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

async fn copy_and_shutdown(
    mut reader: impl AsyncRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    ended: &tokio::sync::Notify,
) -> std::io::Result<()> {
    tokio::io::copy(&mut reader, &mut writer).await?;
    ended.notify_one();
    writer.shutdown().await
}

pub(super) async fn bridge(
    remote: impl AsyncRead + AsyncWrite + Unpin,
    input: impl AsyncWrite + Unpin,
    output: impl AsyncRead + Unpin,
) -> std::io::Result<()> {
    // SSHFS can keep stdout open after its subsystem has ended. Propagate EOF
    // and allow a bounded drain, then let the registry reap the dead transport.
    // Active/idle connections have no drain deadline until a direction ends.
    let (remote_read, remote_write) = tokio::io::split(remote);
    let ended = tokio::sync::Notify::new();
    let transfers = async {
        tokio::try_join!(
            copy_and_shutdown(remote_read, input, &ended),
            copy_and_shutdown(output, remote_write, &ended)
        )?;
        Ok(())
    };
    tokio::pin!(transfers);
    tokio::select! {
        result = &mut transfers => result,
        () = ended.notified() => {
            tokio::time::timeout(DRAIN_TIMEOUT, &mut transfers)
                .await
                .map_err(|_| std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "SSHFS peer kept its transport open after EOF",
                ))?
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn remote_eof_reaches_mount_process_and_drains_its_reply() {
        let (remote, mut server) = tokio::io::duplex(32);
        let (input, mut mount_input) = tokio::io::duplex(32);
        let (mut mount_output, output) = tokio::io::duplex(32);
        let transfer = bridge(remote, input, output);
        let peers = async {
            server.write_all(b"final subsystem response").await?;
            server.shutdown().await?;
            let mut received = Vec::new();
            mount_input.read_to_end(&mut received).await?;
            assert_eq!(received, b"final subsystem response");
            // A process may flush its last outgoing bytes only after stdin EOF.
            mount_output.write_all(b"drained request").await?;
            mount_output.shutdown().await?;
            received.clear();
            server.read_to_end(&mut received).await?;
            assert_eq!(received, b"drained request");
            Ok::<_, std::io::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::try_join!(transfer, peers)
        })
        .await
        .expect("remote EOF was not delivered to the mount process")
        .unwrap();
    }

    #[tokio::test]
    async fn mount_process_eof_reaches_remote_without_discarding_response() {
        let (remote, mut server) = tokio::io::duplex(32);
        let (input, mut mount_input) = tokio::io::duplex(32);
        let (mut mount_output, output) = tokio::io::duplex(32);
        let transfer = bridge(remote, input, output);
        let peers = async {
            mount_output.write_all(b"last request").await?;
            mount_output.shutdown().await?;
            let mut received = Vec::new();
            server.read_to_end(&mut received).await?;
            assert_eq!(received, b"last request");
            server.write_all(b"final response").await?;
            server.shutdown().await?;
            received.clear();
            mount_input.read_to_end(&mut received).await?;
            assert_eq!(received, b"final response");
            Ok::<_, std::io::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::try_join!(transfer, peers)
        })
        .await
        .expect("mount process EOF was not delivered to the remote subsystem")
        .unwrap();
    }

    #[tokio::test]
    async fn remote_eof_does_not_wait_forever_for_an_idle_mount_process() {
        let (remote, mut server) = tokio::io::duplex(32);
        let (input, mut mount_input) = tokio::io::duplex(32);
        // Keep the process output open, matching passive SSHFS after disconnect.
        let (_mount_output, output) = tokio::io::duplex(32);
        server.shutdown().await.unwrap();
        let transfer = bridge(remote, input, output);
        let process = async {
            let mut response = Vec::new();
            mount_input.read_to_end(&mut response).await.unwrap();
            assert!(response.is_empty());
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(transfer, process)
        })
        .await
        .expect("dead transport was not released after its drain deadline");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    }
}
