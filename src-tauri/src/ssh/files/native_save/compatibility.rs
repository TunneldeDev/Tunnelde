//! Opt-in actual producer/consumer tests: only an explicitly selected test binary runs.
use super::{
    client::Client,
    contracts::{
        authority::{Context, Platform},
        operation::{Baseline, Prepared},
        receipt::{Observation, Phase},
        MAX_OUTPUT,
    },
    transport::{Exchange, Failure, Output, Reason},
};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Process {
    executable: PathBuf,
    state: PathBuf,
    context: Context,
}
impl Exchange for Process {
    fn authorize(&self, context: &Context) -> Result<(), Failure> {
        if self.context == *context {
            Ok(())
        } else {
            Err(Failure::before(Reason::AuthorityChanged))
        }
    }
    async fn exchange(&self, input: Vec<u8>) -> Result<Output, Failure> {
        let mut child = tokio::process::Command::new(&self.executable)
            .args(["files-save", "--directory"])
            .arg(&self.state)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Failure::before(Reason::Transport))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap().take((MAX_OUTPUT + 1) as u64);
        let mut stderr = child.stderr.take().unwrap().take((MAX_OUTPUT + 1) as u64);
        let work = async {
            let write = async {
                stdin.write_all(&input).await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            };
            let read = async {
                let mut out = Vec::new();
                let mut err = Vec::new();
                tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
                Ok::<_, std::io::Error>((out, err))
            };
            let (_, (out, err), status) = tokio::try_join!(write, read, child.wait())?;
            Ok::<_, std::io::Error>(Output {
                stdout: out,
                stderr: err,
                code: status.code().map(|v| v as u32),
            })
        };
        tokio::time::timeout(Duration::from_secs(15), work)
            .await
            .map_err(|_| Failure {
                reason: Reason::Timeout,
                dispatched: true,
            })?
            .map_err(|_| Failure {
                reason: Reason::Transport,
                dispatched: true,
            })
    }
}
struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    state: PathBuf,
    context: Context,
    platform: Platform,
}
impl Fixture {
    fn selected() -> Self {
        let executable = PathBuf::from(
            std::env::var_os("TUNNELDE_TEST_FILE_SAVE_HELPER")
                .expect("explicit file-save helper fixture"),
        );
        assert!(executable.is_absolute());
        let root =
            std::env::temp_dir().join(format!("tunnelde-file-save-host-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let root = std::fs::canonicalize(root).unwrap();
        let state = root.join("private-state");
        let platform = if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Posix
        };
        let context = Context {
            host_key: format!("SHA256:{}", "A".repeat(43)),
            account: "isolated-test-account".into(),
            scope: root.to_str().unwrap().into(),
        };
        Self {
            root,
            executable,
            state,
            context,
            platform,
        }
    }
    fn transport(&self) -> Process {
        Process {
            executable: self.executable.clone(),
            state: self.state.clone(),
            context: self.context.clone(),
        }
    }
    async fn initialized(&self) -> Client<Process> {
        Client::initialize(self.transport(), self.context.clone(), self.platform)
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn settled(client: &Client<Process>, prepared: &Prepared) -> Observation {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let observed = client
            .status(&prepared.control, None)
            .await
            .unwrap()
            .expect("admitted original operation");
        if observed.releasable() {
            return observed;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker did not settle: {:?}",
            observed.phase
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[tokio::test]
#[ignore = "requires explicitly built reviewed file-save helper; no runtime discovery or download"]
async fn selected_file_save_helper_executes_and_recovers_original_host_operations() {
    let fixture = Fixture::selected();
    let client = fixture.initialized().await;
    let prepared = Prepared::new(
        client.authority(),
        vec!["host-测试.txt".into()],
        Baseline::Absent,
        "UTF-8 测试\n\"quoted\"\0".into(),
    )
    .unwrap();
    assert!(client
        .status(&prepared.control, None)
        .await
        .unwrap()
        .is_none());
    client.submit(&prepared).await.unwrap();
    // Simulate client loss: only its retained original authority/control survive.
    let authority = client.authority().clone();
    drop(client);
    let restored = Client::restore(fixture.transport(), authority, fixture.platform).unwrap();
    let first = settled(&restored, &prepared).await;
    assert_eq!(first.phase, Phase::Succeeded);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("host-测试.txt")).unwrap(),
        prepared.content
    );
    let duplicate = restored.submit(&prepared).await.unwrap();
    assert_eq!(duplicate.revision, first.revision);
    restored
        .release(&prepared.control, &first, false)
        .await
        .unwrap();
    let prior = prepared.content.clone();
    let replace = Prepared::new(
        restored.authority(),
        vec!["host-测试.txt".into()],
        Baseline::Existing {
            sha256: super::contracts::hash(b"", prior.as_bytes()),
            length: prior.len() as u64,
        },
        "replacement".into(),
    )
    .unwrap();
    restored.submit(&replace).await.unwrap();
    let receipt = settled(&restored, &replace).await;
    assert_eq!(receipt.phase, Phase::Succeeded);
    assert_eq!(receipt.backup_retained, Some(true));
    assert!(restored
        .release(&replace.control, &receipt, false)
        .await
        .is_err());
    restored
        .release(&replace.control, &receipt, true)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("host-测试.txt")).unwrap(),
        "replacement"
    );
    let cancelled = Prepared::new(
        restored.authority(),
        vec!["cancelled.txt".into()],
        Baseline::Absent,
        "no write".into(),
    )
    .unwrap();
    let tombstone = restored.cancel(&cancelled.control).await.unwrap();
    assert_eq!(tombstone.phase, Phase::Cancelled);
    assert_eq!(
        restored.submit(&cancelled).await.unwrap().phase,
        Phase::Cancelled
    );
    assert!(!fixture.root.join("cancelled.txt").exists());
    let terminal = settled(&restored, &cancelled).await;
    restored
        .release(&cancelled.control, &terminal, false)
        .await
        .unwrap();
}
#[tokio::test]
#[ignore = "requires explicitly selected historical helper; unsupported native saves must stay unavailable"]
async fn historical_file_save_helper_is_not_inferred_from_runner_capabilities() {
    let fixture = Fixture::selected();
    let error = Client::initialize(
        fixture.transport(),
        fixture.context.clone(),
        fixture.platform,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.reason, Reason::RemoteRejected);
    assert!(error.dispatched);
    assert!(
        !fixture.state.exists(),
        "old helper must not initialize authority"
    );
}
