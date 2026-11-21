use super::*;
fn status() -> RuleStatus {
    RuleStatus {
        rule_id: "rule".into(),
        group_id: "group".into(),
        revision: "revision".into(),
        runtime_id: Some("runtime".into()),
        session_id: Some("session".into()),
        phase: "running".into(),
        desired: true,
        error: None,
    }
}
fn fixture() -> (Coordinator, Intent) {
    let runtime = Coordinator::default();
    let initial = status();
    let target = Target::capture(std::slice::from_ref(&initial), "rule", "runtime").unwrap();
    runtime.lock().rules.insert("rule".into(), initial);
    (runtime, Intent::new(target))
}
#[test]
fn consent_is_bound_to_rule_group_revision_runtime_and_session() {
    let initial = status();
    let target = Target::capture(std::slice::from_ref(&initial), "rule", "runtime").unwrap();
    for index in 0..5 {
        let mut changed = initial.clone();
        match index {
            0 => changed.rule_id = "new-rule".into(),
            1 => changed.group_id = "new-group".into(),
            2 => changed.revision = "new-revision".into(),
            3 => changed.runtime_id = Some("new-runtime".into()),
            _ => changed.session_id = Some("new-session".into()),
        }
        assert!(target.recheck(&[changed]).is_err());
    }
    assert!(target.recheck(&[]).is_err());
    target.recheck(&[initial]).unwrap();
}
#[test]
fn only_a_current_instance_can_open_the_confirmation() {
    assert!(Target::capture(&[status()], "rule", "old-runtime").is_err());
    let mut stopped = status();
    stopped.runtime_id = None;
    assert!(Target::capture(&[stopped], "rule", "runtime").is_err());
}
#[test]
fn rejected_admission_preserves_intent_and_settlement_does_not_modify_it() {
    let (runtime, intent) = fixture();
    let before = serde_json::to_value(runtime.rule_states()).unwrap();
    assert!(intent
        .commit(&runtime, || Err(repository::changed()))
        .is_err());
    assert!(!intent.settle(&runtime, &Err(repository::changed())));
    assert_eq!(serde_json::to_value(runtime.rule_states()).unwrap(), before);
}
#[test]
fn a_replacement_instance_cannot_consume_or_be_modified_by_an_old_intent() {
    let (runtime, intent) = fixture();
    runtime.lock().rules.get_mut("rule").unwrap().runtime_id = Some("replacement".into());
    assert!(intent
        .commit(&runtime, || panic!("old consent admitted"))
        .is_err());
    assert!(!intent.settle(&runtime, &Ok(())));
    assert!(runtime.rule_states()[0].desired);
    let (runtime, intent) = fixture();
    intent.commit(&runtime, || Ok(())).unwrap();
    runtime.lock().rules.get_mut("rule").unwrap().runtime_id = Some("replacement".into());
    assert!(!intent.settle(&runtime, &Ok(())));
    assert_eq!(
        runtime.rule_states()[0].runtime_id.as_deref(),
        Some("replacement")
    );
}
#[test]
fn admitted_stop_survives_loss_of_delivery_and_failure_retains_cleanup_identity() {
    for failed in [false, true] {
        let (runtime, intent) = fixture();
        intent.commit(&runtime, || Ok(())).unwrap();
        assert!(!runtime.rule_states()[0].desired); // Recovery must never restart it.
        let result = if failed {
            Err(crate::error::AppError::validation("mounts.busy"))
        } else {
            Ok(())
        };
        assert!(intent.settle(&runtime, &result));
        let status = &runtime.rule_states()[0];
        assert!(!status.desired);
        assert_eq!(
            status.phase,
            if failed { "cleanupRequired" } else { "stopped" }
        );
        if failed {
            assert_eq!(status.runtime_id.as_deref(), Some("runtime"));
            assert!(status.error.is_some());
        } else {
            assert!(
                status.runtime_id.is_none()
                    && status.session_id.is_none()
                    && status.error.is_none()
            );
        }
    }
}

/// Exercises the production Intent inside the real retained unmount worker,
/// without AppHandle or a physical FUSE filesystem. Admission is deliberately a
/// test grant; the captured invocation fence is still the actual request gate.
pub(crate) fn worker_policy(
    runtime: Arc<Coordinator>,
    granted: Arc<AtomicBool>,
    group: OwnedMutexGuard<()>,
) -> impl Policy {
    struct TestPolicy {
        runtime: Arc<Coordinator>,
        granted: Arc<AtomicBool>,
        intent: Intent,
        _group: OwnedMutexGuard<()>,
    }
    impl Policy for TestPolicy {
        fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
            if !self.granted.load(Ordering::Acquire) {
                return Err(repository::changed());
            }
            effect()
        }
        fn commit(&self, effect: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
            self.intent.commit(&self.runtime, effect)
        }
        fn settled(&self, result: &AppResult<()>) {
            self.intent.settle(&self.runtime, result);
        }
    }
    let mut status = status();
    status.runtime_id = Some("mount".into());
    let target = Target::capture(std::slice::from_ref(&status), "rule", "mount").unwrap();
    runtime.lock().rules.insert("rule".into(), status);
    TestPolicy {
        runtime,
        granted,
        intent: Intent::new(target),
        _group: group,
    }
}
