//! One listener owns the bounded connection work admitted through it.
use std::{future::Future, io, sync::Arc};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
};

const MAX_CONNECTIONS: usize = 8;

pub(super) async fn serve<F, W>(
    listener: TcpListener,
    mut shutdown: watch::Receiver<bool>,
    connection: F,
) -> io::Result<()>
where
    F: Fn(TcpStream) -> W + Send + 'static,
    W: Future<Output = io::Result<()>> + Send + 'static,
{
    let capacity = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let mut connections = tokio::task::JoinSet::new();
    loop {
        if *shutdown.borrow() {
            return Ok(());
        }
        let (stream, peer) = tokio::select! {
            biased;
            _ = shutdown.changed() => return Ok(()),
            Some(_) = connections.join_next() => continue,
            accepted = listener.accept() => accepted?,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        if *shutdown.borrow() {
            return Ok(());
        }
        let Ok(permit) = capacity.clone().try_acquire_owned() else {
            continue;
        };
        let work = connection(stream);
        connections.spawn(async move {
            let _permit = permit;
            // Dropping an admitted request stops this async exchange. Blocking
            // side effects already admitted by a domain keep its own lifecycle.
            let _ = work.await;
        });
    }
}

#[cfg(test)]
#[path = "listener/tests.rs"]
mod tests;
