use super::*;
use crate::services::operations::{Budget, Errors, WorkLifetime};
use std::time::Duration;

fn shell(script: &str) -> Child {
    command("/bin/sh")
        .args(["-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}
fn reaped(child: &mut Child) {
    assert!(
        child.id().is_none(),
        "probe returned before reaping its child"
    );
    assert!(child.try_wait().unwrap().is_some());
}
#[tokio::test]
async fn successful_help_probes_read_both_streams_and_reap_nonzero_help_exit() {
    for script in [
        "printf '%s\\n' '-o slave   stdio'; exit 1",
        "printf '%s\\n' '-o slave   stdio' >&2",
    ] {
        let mut child = shell(script);
        assert_eq!(
            probe_transport(&mut child, Duration::from_secs(3)).await,
            Some("slave".into())
        );
        reaped(&mut child);
    }
}
#[tokio::test]
async fn unsupported_help_does_not_claim_an_available_transport() {
    let mut child = shell("printf '%s\\n' '-o slave_other' 'supports passive devices'");
    assert_eq!(
        probe_transport(&mut child, Duration::from_secs(3)).await,
        None
    );
    reaped(&mut child);
}
#[tokio::test]
async fn timed_out_help_is_killed_and_reaped_before_return() {
    let mut child = shell("exec sleep 30");
    assert_eq!(probe_transport(&mut child, Duration::ZERO).await, None);
    reaped(&mut child);
}
#[tokio::test]
async fn malformed_probe_pipes_still_kill_and_reap_the_child() {
    let mut child = shell("exec sleep 30");
    drop(child.stdout.take());
    assert_eq!(
        probe_transport(&mut child, Duration::from_secs(3)).await,
        None
    );
    reaped(&mut child);
}
#[tokio::test]
async fn oversized_help_is_bounded_and_the_process_is_reaped() {
    for stream in ["", " >&2"] {
        let mut child = shell(&format!(
            "i=0; while [ $i -lt 4096 ]; do printf '0123456789'{stream}; i=$((i+1)); done"
        ));
        assert_eq!(
            probe_transport(&mut child, Duration::from_secs(3)).await,
            None
        );
        reaped(&mut child);
    }
}
struct Effect(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for Effect {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}
#[tokio::test]
async fn cancelling_probe_delivery_retains_the_actual_effect_through_child_reaping() {
    let (effect, mut settled) = tokio::sync::oneshot::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    let (cleaned, cleanup) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(WorkLifetime::new(Effect(Some(effect))).scope(async move {
        let budget = Budget::new(
            1,
            Errors {
                domain: "test.dependencies",
                busy: "busy",
                cancelled: "cancelled",
                failed: "failed",
            },
        );
        budget
            .asynchronous(|_| async move {
                let mut child = shell("exec sleep 30");
                started.send(()).unwrap();
                wait.await.unwrap();
                assert_eq!(probe_transport(&mut child, Duration::ZERO).await, None);
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
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), cleanup)
        .await
        .unwrap()
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), settled)
        .await
        .unwrap()
        .is_ok());
}
