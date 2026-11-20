use super::*;
use crate::services::operations::{Budget, Errors, WorkLifetime};
use std::sync::Arc;
use tokio::sync::{oneshot, Semaphore};

fn shell(script: &str) -> Command {
    let mut command = super::super::command("/bin/sh");
    command.args(["-c", script]);
    command
}
fn child(script: &str) -> Child {
    shell(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}
fn reaped(child: &mut Child) {
    assert!(child.id().is_none(), "helper returned before child reap");
    assert!(child.try_wait().unwrap().is_some());
}
#[tokio::test]
async fn real_output_preserves_both_streams_and_nonzero_exit_for_caller_policy() {
    let value = output(
        shell("printf 'stdout'; printf 'stderr' >&2; exit 7"),
        Duration::from_secs(3),
        1024,
        "timed-out",
    )
    .await
    .unwrap();
    assert_eq!(value.stdout, b"stdout");
    assert_eq!(value.stderr, b"stderr");
    assert_eq!(value.status.code(), Some(7));
}
#[tokio::test]
async fn output_bounds_both_pipes_without_deadlocking_or_inferring_success() {
    for stream in ["", " >&2"] {
        let mut child = child(&format!(
            "i=0; while [ $i -lt 2048 ]; do printf '0123456789'{stream}; i=$((i+1)); done"
        ));
        assert_eq!(
            collect(&mut child, Duration::from_secs(3), 1024, "timed-out")
                .await
                .unwrap_err()
                .to_string(),
            "mounts.helperOutputTooLarge"
        );
        reaped(&mut child);
    }
}
#[tokio::test]
async fn exact_limit_is_accepted_and_the_child_is_reaped() {
    let mut child = child("printf '1234'; printf '5678' >&2");
    let value = collect(&mut child, Duration::from_secs(3), 4, "timed-out")
        .await
        .unwrap();
    assert_eq!(value.stdout, b"1234");
    assert_eq!(value.stderr, b"5678");
    reaped(&mut child);
}
#[tokio::test]
async fn timeout_and_pipe_failure_do_not_return_until_child_kill_and_reap() {
    let mut expired = child("exec sleep 30");
    assert_eq!(
        collect(&mut expired, Duration::ZERO, 1024, "timed-out")
            .await
            .unwrap_err()
            .to_string(),
        "timed-out"
    );
    reaped(&mut expired);
    let mut malformed = child("exec sleep 30");
    drop(malformed.stdout.take());
    assert_eq!(
        collect(&mut malformed, Duration::from_secs(3), 1024, "timed-out")
            .await
            .unwrap_err()
            .to_string(),
        "mounts.helperFailed"
    );
    reaped(&mut malformed);
}
#[tokio::test]
async fn missing_probe_preserves_the_original_io_error() {
    let error = output(
        super::super::command(format!(
            "/nonexistent-tunnelde-helper-{}",
            uuid::Uuid::new_v4()
        )),
        Duration::from_secs(3),
        1024,
        "timed-out",
    )
    .await
    .unwrap_err();
    assert!(matches!(error, AppError::Io(error) if error.kind() == std::io::ErrorKind::NotFound));
}
struct Effect(Option<oneshot::Sender<()>>);
impl Drop for Effect {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}
#[tokio::test]
async fn cancelled_delivery_retains_worker_capacity_and_effect_until_actual_reap() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(
        capacity.clone(),
        Errors {
            domain: "test.mount-helper",
            busy: "busy",
            cancelled: "cancelled",
            failed: "failed",
        },
    ));
    let (effect, mut settled) = oneshot::channel();
    let (started, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let (cleaned, cleanup) = oneshot::channel();
    let worker = budget.clone();
    let caller = tokio::spawn(WorkLifetime::new(Effect(Some(effect))).scope(async move {
        worker
            .asynchronous(|_| async move {
                let mut child = child("exec sleep 30");
                started.send(()).unwrap();
                wait.await.unwrap();
                assert!(collect(&mut child, Duration::ZERO, 1024, "timed-out")
                    .await
                    .is_err());
                reaped(&mut child);
                cleaned.send(()).unwrap();
                Ok(())
            })
            .await
    }));
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(matches!(
        settled.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        budget
            .asynchronous(|_| async { Ok(()) })
            .await
            .unwrap_err()
            .to_string(),
        "busy"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), cleanup)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), settled)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capacity.available_permits(), 1);
}
