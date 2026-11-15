use super::*;
use crate::{db, network::ProxyProfile, settings::Settings};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn settings() -> Settings {
    Settings {
        network: NetworkSettings {
            default_proxy: "chosen".into(),
            profiles: vec![ProxyProfile {
                id: "chosen".into(),
                name: "Display".into(),
                protocol: "http".into(),
                host: "127.0.0.1".into(),
                port: 7890,
                username: "qa".into(),
            }],
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn process_route_rejects_persisted_edits_before_memory_publication_and_corruption() {
    db::Database::in_memory()
        .unwrap()
        .with(|conn| {
            let memory = settings();
            db::settings::save(conn, &memory)?;
            let original = selected(&memory.network, "qa")?;
            verify_saved(conn, &original, "qa")?;
            for field in 0..8 {
                let mut durable = memory.clone();
                match field {
                    0 => durable.network.profiles[0].host = "elsewhere".into(),
                    1 => durable.network.profiles[0].port += 1,
                    2 => durable.network.profiles[0].username = "changed".into(),
                    3 => durable.network.profiles[0].protocol = "socks5".into(),
                    4 => durable.network.default_proxy = "direct".into(),
                    5 => {
                        durable
                            .network
                            .features
                            .insert("processes".into(), "direct".into());
                    }
                    6 => {
                        durable
                            .network
                            .features
                            .insert("plugin:qa".into(), "direct".into());
                    }
                    _ => durable.network.profiles.clear(),
                }
                db::settings::save(conn, &durable)?;
                assert_eq!(
                    verify_saved(conn, &original, "qa").unwrap_err().to_string(),
                    "network.configurationChanged"
                );
            }
            conn.execute(
                "UPDATE settings SET value='broken json' WHERE key='app'",
                [],
            )?;
            assert!(verify_saved(conn, &original, "qa").is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn plugin_selection_dominates_process_default_and_ignores_cosmetics() {
    let mut settings = settings();
    settings
        .network
        .features
        .insert("plugin:qa".into(), "chosen".into());
    let original = selected(&settings.network, "qa").unwrap();
    settings.network.default_proxy = "direct".into();
    settings
        .network
        .features
        .insert("processes".into(), "system".into());
    settings
        .network
        .features
        .insert("plugin:other".into(), "direct".into());
    settings.network.profiles[0].name = "Renamed".into();
    current(&original, &settings.network, "qa").unwrap();
    settings.network.features.remove("plugin:qa");
    assert!(current(&original, &settings.network, "qa").is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn process_os_preparation_is_bounded_and_preserves_native_errors() {
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let task = tokio::spawn(prepare(
        move || {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
            Err::<(), _>(AppError::Ssh("vault.load: isolated failure".into()))
        },
        Duration::from_secs(10),
    ));
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .unwrap()
        .unwrap();
    // A timer on this sole runtime thread still runs while the actual OS worker waits.
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(!task.is_finished());
    release.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "vault.load: isolated failure"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn abandoned_process_preparation_cannot_apply_a_late_proxy_environment() {
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let published = Arc::new(AtomicBool::new(false));
    let observed = published.clone();
    let task = tokio::spawn(async move {
        prepare(
            move || {
                ready.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(10)).unwrap();
                finished.send(()).unwrap();
                Ok(())
            },
            Duration::from_secs(10),
        )
        .await?;
        observed.store(true, Ordering::SeqCst);
        Ok::<_, AppError>(())
    });
    started.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    done.await.unwrap();
    assert!(!published.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "current_thread")]
async fn process_preparation_timeout_keeps_late_os_results_private() {
    let (release, wait) = std::sync::mpsc::channel();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(prepare(
        move || {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
            finished.send(()).unwrap();
            Ok(())
        },
        Duration::from_secs(1),
    ));
    started.await.unwrap();
    let result = task.await.unwrap();
    release.send(()).unwrap();
    done.await.unwrap();
    assert_eq!(result.unwrap_err().to_string(), "network.timeout");
}

// A real child checks its environment without printing proxy values.
fn child(expected: &str) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile","-NonInteractive","-Command", "$names='HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'; foreach($name in $names) { $v=[Environment]::GetEnvironmentVariable($name); if ($v -ne $env:QA_EXPECT) { exit 1 } }; $names='NO_PROXY','no_proxy'; foreach($name in $names) { if ([Environment]::GetEnvironmentVariable($name) -ne $env:QA_NO_PROXY) { exit 2 } }; if ($env:NODE_USE_ENV_PROXY -ne $env:QA_NODE) { exit 3 }; exit 0"]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", r#"[ "${HTTP_PROXY-}" = "$QA_EXPECT" ] && [ "${HTTPS_PROXY-}" = "$QA_EXPECT" ] && [ "${ALL_PROXY-}" = "$QA_EXPECT" ] && [ "${http_proxy-}" = "$QA_EXPECT" ] && [ "${https_proxy-}" = "$QA_EXPECT" ] && [ "${all_proxy-}" = "$QA_EXPECT" ] || exit 1; [ "${NO_PROXY-}" = "$QA_NO_PROXY" ] && [ "${no_proxy-}" = "$QA_NO_PROXY" ] || exit 2; [ "${NODE_USE_ENV_PROXY-}" = "$QA_NODE" ] || exit 3"#]);
        c
    };
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env(name, "inherited-fixture");
    }
    command
        .env("NO_PROXY", "inherited-bypass")
        .env("no_proxy", "inherited-bypass")
        .env("NODE_USE_ENV_PROXY", "inherited-node")
        .env("QA_EXPECT", expected)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}
#[tokio::test]
async fn actual_child_preserves_system_direct_and_authenticated_proxy_environment() {
    for (url, expected, no_proxy, node) in [
        (
            None,
            "inherited-fixture",
            "inherited-bypass",
            "inherited-node",
        ),
        (Some(""), "", "", ""),
        (
            Some("http://qa-fixture-only@127.0.0.1:12345/"),
            "http://qa-fixture-only@127.0.0.1:12345/",
            "localhost,127.0.0.1,::1",
            "1",
        ),
    ] {
        let mut command = child(expected);
        command.env("QA_NO_PROXY", no_proxy).env("QA_NODE", node);
        apply(url, &mut command);
        assert!(
            command.status().await.unwrap().success(),
            "child proxy environment contract failed"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn process_database_wait_yields_and_can_be_abandoned_without_running_its_callback() {
    let db = Arc::new(db::Database::in_memory().unwrap());
    let worker_db = db.clone();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        worker_db.with(|_| {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
    });
    started.await.unwrap();
    let entered = Arc::new(AtomicBool::new(false));
    let callback = entered.clone();
    let pending_db = db.clone();
    let task = tokio::spawn(async move {
        available(
            &pending_db,
            tokio::time::Instant::now() + Duration::from_secs(10),
            |_| {
                callback.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!task.is_finished());
    assert!(!entered.load(Ordering::SeqCst));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert!(!entered.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "current_thread")]
async fn process_database_wait_deadline_includes_contention_and_never_runs_late() {
    let db = Arc::new(db::Database::in_memory().unwrap());
    let worker_db = db.clone();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        worker_db.with(|_| {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
    });
    started.await.unwrap();
    let mut entered = false;
    let result = available(
        &db,
        tokio::time::Instant::now() + Duration::from_millis(25),
        |_| {
            entered = true;
            Ok(())
        },
    )
    .await;
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(result.unwrap_err().to_string(), "network.timeout");
    assert!(!entered);
    available(
        &db,
        tokio::time::Instant::now() + Duration::from_secs(2),
        |_| Ok(()),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn final_process_database_admission_rechecks_the_original_choice_after_waiting() {
    let db = Arc::new(db::Database::in_memory().unwrap());
    let memory = settings();
    db.with(|conn| db::settings::save(conn, &memory)).unwrap();
    let original = selected(&memory.network, "qa").unwrap();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker_db = db.clone();
    let mut durable = memory.clone();
    durable.network.default_proxy = "direct".into();
    let worker = std::thread::spawn(move || {
        worker_db.with(|conn| {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
            db::settings::save(conn, &durable)
        })
    });
    started.await.unwrap();
    let final_db = db.clone();
    let task = tokio::spawn(async move {
        available(
            &final_db,
            tokio::time::Instant::now() + Duration::from_secs(5),
            |conn| verify_saved(conn, &original, "qa"),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!task.is_finished());
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "network.configurationChanged"
    );
    assert_eq!(memory.network.default_proxy, "chosen");
}

#[tokio::test]
async fn available_database_preserves_original_read_errors_and_expired_preparation_never_reads() {
    let db = db::Database::in_memory().unwrap();
    let error = available(
        &db,
        tokio::time::Instant::now() + Duration::from_secs(2),
        |_| Err::<(), _>(AppError::Ssh("original-read-error".into())),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "original-read-error");
    assert_eq!(
        prepare(
            || -> AppResult<()> { panic!("expired read") },
            Duration::ZERO
        )
        .await
        .err()
        .unwrap()
        .to_string(),
        "network.timeout"
    );
}
