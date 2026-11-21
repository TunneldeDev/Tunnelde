use super::*;
use std::{cell::Cell, future};

fn targets(ids: &[&str]) -> Vec<Target> {
    ids.iter()
        .map(|id| Target {
            id: (*id).into(),
            expected_revision: "saved-revision".into(),
        })
        .collect()
}

#[test]
fn validates_the_entire_request_before_any_attempt() {
    assert!(validate("session", &targets(&["ok"])).is_ok());
    assert!(validate("session", &[]).is_err());
    assert!(validate("session", &targets(&["ok", "ok"])).is_err());
    assert!(validate("session", &targets(&["bad\n"])).is_err());
    assert!(validate("", &targets(&["ok"])).is_err());
}

#[tokio::test]
async fn reports_results_in_order_without_rolling_back_successes() {
    let results = run(
        targets(&["one", "stale", "three"]),
        Instant::now() + BUDGET,
        || Ok(()),
        |target| {
            future::ready(if target.id == "stale" {
                Err(AppError::validation("forward.changed"))
            } else {
                Ok(())
            })
        },
    )
    .await
    .unwrap();
    let response = encode(results).unwrap();
    assert_eq!(
        response[0],
        serde_json::json!({"id":"one","status":"started"})
    );
    assert_eq!(response[1]["id"], "stale");
    assert_eq!(response[1]["status"], "failed");
    assert_eq!(response[1]["error"]["message"], "forward.changed");
    assert_eq!(
        response[2],
        serde_json::json!({"id":"three","status":"started"})
    );
}

#[tokio::test]
async fn revocation_stops_remainder_and_cannot_return_a_success_receipt() {
    let attempts = Cell::new(0);
    let results = run(
        targets(&["one", "two"]),
        Instant::now() + BUDGET,
        || {
            if attempts.get() > 0 {
                Err(AppError::validation("pluginSecurity.unavailable"))
            } else {
                Ok(())
            }
        },
        |_| {
            attempts.set(attempts.get() + 1);
            future::ready(Ok(()))
        },
    )
    .await;
    assert!(results.is_err());
    assert_eq!(attempts.get(), 1);
}

#[tokio::test]
async fn exhausted_budget_never_submits_the_remaining_rules() {
    let results = run(
        targets(&["one", "two"]),
        Instant::now(),
        || Ok(()),
        |_| -> future::Ready<AppResult<()>> { panic!("expired batch submitted a listener") },
    )
    .await
    .unwrap();
    assert_eq!(
        encode(results).unwrap(),
        serde_json::json!([
            {"id":"one","status":"notStarted"}, {"id":"two","status":"notStarted"}
        ])
    );
}

#[tokio::test(start_paused = true)]
async fn pending_attempt_is_dropped_on_deadline_before_advancing() {
    struct Pending<'a>(&'a Cell<bool>);
    impl Drop for Pending<'_> {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }
    let released = Cell::new(false);
    let results = run(
        targets(&["slow", "later"]),
        Instant::now() + BUDGET,
        || Ok(()),
        |target| {
            assert_eq!(target.id, "slow");
            let pending = Pending(&released);
            async move {
                let _pending = pending;
                future::pending().await
            }
        },
    )
    .await
    .unwrap();
    assert!(released.get());
    let response = encode(results).unwrap();
    assert_eq!(response[0]["error"]["message"], "plugin.timeout");
    assert_eq!(response[1]["status"], "notStarted");
}
