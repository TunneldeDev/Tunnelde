use super::*;

fn info(ms: u64) -> HostKeyInfo {
    HostKeyInfo {
        host_id: "target".into(),
        fingerprint: "SHA256:trusted".into(),
        algorithm: "ssh-ed25519".into(),
        status: HostKeyStatus::Known,
        known_fingerprint: Some("SHA256:trusted".into()),
        connection_time_ms: Some(ms),
    }
}

#[test]
fn summaries_use_successful_samples_and_never_treat_failed_attempts_as_zero() {
    for (samples, expected, median, spread) in [
        (
            vec![Some(50), Some(30), Some(40)],
            Quality::Fast,
            Some(40),
            Some(20),
        ),
        (
            vec![Some(501), Some(1500), Some(700)],
            Quality::Normal,
            Some(700),
            Some(999),
        ),
        (vec![Some(1600); 3], Quality::Slow, Some(1600), Some(0)),
        (
            vec![Some(100), None, Some(200)],
            Quality::Unstable,
            Some(150),
            Some(100),
        ),
        (vec![None; 3], Quality::Unreachable, None, None),
    ] {
        let summary = summarize(samples.clone(), None);
        assert_eq!(summary.quality, expected);
        assert_eq!(summary.median_ms, median);
        assert_eq!(summary.spread_ms, spread);
        assert_eq!(summary.attempts, samples.len());
        assert_eq!(summary.successful, samples.iter().flatten().count());
    }
}

#[tokio::test]
async fn rejects_unknown_changed_and_wrong_route_keys_before_reporting_quality() {
    for (status, host_id, error) in [
        (HostKeyStatus::Unknown, "target", "ssh.hostKeyUntrusted"),
        (HostKeyStatus::Changed, "target", "ssh.hostKeyChanged"),
        (HostKeyStatus::Known, "jump", "ssh.hostKeyUntrusted"),
    ] {
        let mut calls = 0;
        let result = measure(
            "target",
            || {
                calls += 1;
                let mut probe = info(20);
                probe.status = status;
                probe.host_id = host_id.into();
                std::future::ready(Ok(probe))
            },
            BUDGET,
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), error);
        assert_eq!(calls, 1);
    }
    let mut calls = 0;
    let result = measure(
        "target",
        || {
            calls += 1;
            let mut probe = info(20);
            if calls > 1 {
                probe.fingerprint = "SHA256:other".into();
            }
            std::future::ready(Ok(probe))
        },
        BUDGET,
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "ssh.hostKeyChanged");
    assert_eq!(calls, 2);
}

#[tokio::test]
async fn never_retries_authentication_or_proxy_credentials_but_records_transport_failures() {
    for message in [
        "ssh.authFailed",
        "ssh.passwordRequired",
        "ssh.keyLoad: unreadable",
    ] {
        let mut calls = 0;
        let result = measure(
            "target",
            || {
                calls += 1;
                std::future::ready(Err(AppError::Ssh(message.into())))
            },
            BUDGET,
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), message);
        assert_eq!(calls, 1);
    }
    let mut calls = 0;
    let result = measure(
        "target",
        || {
            calls += 1;
            std::future::ready(Err(AppError::validation("network.proxyRejected")))
        },
        BUDGET,
    )
    .await;
    assert!(result.is_err());
    assert_eq!(calls, 1);

    let mut calls = 0;
    let result = measure(
        "target",
        || {
            calls += 1;
            std::future::ready(if calls == 2 {
                Err(AppError::validation("network.timeout"))
            } else {
                Ok(info(60))
            })
        },
        BUDGET,
    )
    .await
    .unwrap();
    assert_eq!(result.quality, Quality::Unstable);
    assert_eq!(result.successful, 2);
    assert_eq!(result.samples_ms, vec![Some(60), None, Some(60)]);
    assert_eq!(result.last_error.as_deref(), Some("network.timeout"));
}

#[tokio::test]
async fn timeout_is_bounded_and_drops_inflight_work() {
    let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct Guard(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let result = measure(
        "target",
        || {
            let guard = Guard(dropped.clone());
            async move {
                let _guard = guard;
                std::future::pending().await
            }
        },
        Duration::from_millis(30),
    )
    .await
    .unwrap();
    assert_eq!(result.attempts, 1);
    assert_eq!(result.quality, Quality::Unreachable);
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test]
async fn cancellation_releases_registration_and_also_handles_cancel_before_start() {
    let ssh = SshManager::default();
    let id = uuid::Uuid::new_v4().to_string();
    let (guard, cancellation) = register(&ssh, &id, "target").unwrap();
    let second = uuid::Uuid::new_v4().to_string();
    assert!(register(&ssh, &second, "target").is_err());
    cancel(&ssh, &id);
    let result = Abortable::new(std::future::pending::<()>(), cancellation).await;
    assert!(result.is_err());
    drop(guard);
    assert!(ssh.diagnostics.lock().unwrap().running.is_empty());
    assert!(register(&ssh, &second, "target").is_ok());
    cancel(&ssh, &id);
    assert_eq!(
        register(&ssh, &id, "target").err().unwrap().to_string(),
        "ssh.testCancelled"
    );
    assert!(ssh.diagnostics.lock().unwrap().cancelled.is_empty());
}

#[test]
fn registrations_and_early_cancellations_have_bounded_capacity() {
    let ssh = SshManager::default();
    let ids: Vec<_> = (0..5).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    let mut guards = Vec::new();
    for (i, id) in ids[..4].iter().enumerate() {
        guards.push(register(&ssh, id, &format!("target{i}")).unwrap().0);
    }
    assert!(register(&ssh, &ids[4], "other").is_err());
    assert!(register(&ssh, "invalid", "other").is_err());
    drop(guards);
    assert!(ssh.diagnostics.lock().unwrap().running.is_empty());
    for _ in 0..100 {
        cancel(&ssh, &uuid::Uuid::new_v4().to_string());
    }
    cancel(&ssh, "invalid");
    assert_eq!(ssh.diagnostics.lock().unwrap().cancelled.len(), 64);
}

#[tokio::test]
#[ignore = "requires the explicitly configured disposable SSH test host and its reviewed fingerprint"]
async fn live_handshakes_without_login_or_remote_commands() {
    let address = std::env::var("TUNNELDE_SSH_TEST_ADDRESS").expect("explicit host:port");
    let fingerprint = std::env::var("TUNNELDE_SSH_TEST_FINGERPRINT").expect("reviewed host key");
    let result = measure(
        "target",
        || async {
            let started = std::time::Instant::now();
            let stream = tokio::net::TcpStream::connect(&address).await?;
            let (handle, _, _) =
                crate::ssh::session::handshake(Box::pin(stream), Some(fingerprint.clone())).await?;
            let ms = started.elapsed().as_millis() as u64;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            let mut probe = info(ms);
            probe.fingerprint = fingerprint.clone();
            probe.known_fingerprint = Some(fingerprint.clone());
            Ok(probe)
        },
        BUDGET,
    )
    .await
    .unwrap();
    assert_eq!(result.successful, 3);
    println!("{}", serde_json::to_string(&result).unwrap());
}
