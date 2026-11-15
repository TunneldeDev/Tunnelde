//! Bridge the authenticated subsystem and the mount process's separate pipes.
use tokio::io::{AsyncRead, AsyncWrite};

pub(super) async fn bridge(
    mut remote: impl AsyncRead + AsyncWrite + Unpin,
    input: impl AsyncWrite + Unpin,
    output: impl AsyncRead + Unpin,
) -> std::io::Result<()> {
    // Propagate each EOF with shutdown while continuing to drain the other
    // direction. Plain copy + try_join leaves both peers waiting for EOF.
    let mut process = tokio::io::join(output, input);
    tokio::io::copy_bidirectional(&mut remote, &mut process).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
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
}
