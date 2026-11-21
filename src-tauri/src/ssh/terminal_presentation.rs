//! Private actor endpoint for one exact PTY. It cannot connect/disconnect SSH,
//! find another session or grant itself a native-window lease.
use super::session::WriterMsg;
use crate::error::{AppError, AppResult};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(crate) type Output = Arc<dyn Fn(u64, &[u8]) -> bool + Send + Sync>;
pub(crate) struct Authorization {
    pub current: Arc<dyn Fn() -> bool + Send + Sync>,
    // The native broker's effect fence survives a dropped IPC receiver and
    // stays alive through the *actual* actor operation, not just its admission.
    pub retention: Box<dyn Send>,
}
pub(crate) enum Operation {
    Attach(Output),
    Detach,
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}
pub(super) struct Request {
    pub authorization: Authorization,
    pub operation: Operation,
    pub reply: oneshot::Sender<AppResult<Option<u64>>>,
}
#[derive(Clone)]
pub(crate) struct Endpoint {
    pub session_id: String,
    pub(super) writer: mpsc::Sender<WriterMsg>,
}
impl Endpoint {
    #[cfg(test)]
    pub(crate) fn testing(session_id: &str) -> (Self, impl Send) {
        let (writer, receiver) = mpsc::channel(64);
        (
            Self {
                session_id: session_id.into(),
                writer,
            },
            receiver,
        )
    }
    pub fn same(&self, other: &Self) -> bool {
        self.session_id == other.session_id && self.writer.same_channel(&other.writer)
    }
    pub fn closed(&self) -> bool {
        self.writer.is_closed()
    }
    pub async fn request(
        &self,
        authorization: Authorization,
        operation: Operation,
    ) -> AppResult<Option<u64>> {
        let (reply, result) = oneshot::channel();
        self.writer
            .try_send(WriterMsg::Presentation(Request {
                authorization,
                operation,
                reply,
            }))
            .map_err(|_| AppError::validation("ssh.sessionBusy"))?;
        // If the caller disappears, the queued message still retains its effect
        // fence. Never abort/retry an already admitted actor operation here.
        result
            .await
            .map_err(|_| AppError::validation("ssh.sessionMissing"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Retention(Arc<AtomicBool>);
    impl Drop for Retention {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn abandoned_awaiters_do_not_release_an_admitted_actor_effect_early() {
        let (writer, mut receiver) = mpsc::channel(1);
        let endpoint = Endpoint {
            session_id: "exact".into(),
            writer,
        };
        let retired = Arc::new(AtomicBool::new(false));
        let guard = retired.clone();
        let work = tokio::spawn(async move {
            endpoint
                .request(
                    Authorization {
                        current: Arc::new(|| true),
                        retention: Box::new(Retention(guard)),
                    },
                    Operation::Write(b"one".to_vec()),
                )
                .await
        });
        let WriterMsg::Presentation(request) = receiver.recv().await.unwrap() else {
            panic!("wrong message")
        };
        work.abort();
        let _ = work.await;
        assert!(!retired.load(Ordering::SeqCst));
        assert!((request.authorization.current)());
        drop(request);
        assert!(retired.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn refused_admission_releases_its_own_fence_and_never_retries_the_effect() {
        let (writer, _receiver) = mpsc::channel(1);
        writer.try_send(WriterMsg::Attach).unwrap();
        let endpoint = Endpoint {
            session_id: "exact".into(),
            writer,
        };
        let retired = Arc::new(AtomicBool::new(false));
        assert!(endpoint
            .request(
                Authorization {
                    current: Arc::new(|| true),
                    retention: Box::new(Retention(retired.clone()))
                },
                Operation::Write(vec![1])
            )
            .await
            .is_err());
        assert!(retired.load(Ordering::SeqCst));
    }
}
