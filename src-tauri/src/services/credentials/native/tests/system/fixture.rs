use super::*;
use std::{collections::BTreeSet, path::PathBuf, sync::Mutex};

/// Records only keys in an owned random namespace, before each OS mutation.
/// Values are never written to the database, child environment or test output.
pub(super) struct Store {
    pub(super) service: String,
    vault: crate::vault::Vault,
    keys: Mutex<BTreeSet<String>>,
}

impl Store {
    pub(super) fn new() -> Self {
        let service = format!("qa.tunnelde-bindings.{}", Uuid::new_v4());
        Self {
            vault: crate::vault::Vault::new(&service).unwrap(),
            service,
            keys: Mutex::new(BTreeSet::new()),
        }
    }

    pub(super) fn keys(&self) -> Vec<String> {
        self.keys.lock().unwrap().iter().cloned().collect()
    }

    pub(super) fn assert_empty(&self) {
        for key in self.keys() {
            self.vault.forget(&key).unwrap();
            assert!(self.vault.load(&key).unwrap().is_none());
        }
    }
}

impl Platform for Store {
    fn read(&self, item: &str) -> AppResult<Option<String>> {
        self.vault.load(item)
    }

    fn write(&self, item: &str, secret: &str) -> AppResult<()> {
        self.keys.lock().unwrap().insert(item.into());
        self.vault.save(item, secret)
    }

    fn delete(&self, item: &str) -> AppResult<()> {
        self.vault.forget(item)
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        for key in self.keys() {
            let _ = self.vault.forget(&key);
        }
    }
}

pub(super) struct Directory(pub(super) PathBuf);
impl Directory {
    pub(super) fn new() -> Self {
        let base = std::env::var_os("RUNNER_TEMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!("tunnelde-native-bindings-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        // Only this fixture's unique directory; never a user data root.
        if !std::thread::panicking() {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

pub(super) fn upgrade(path: &std::path::Path, host: &str, proxy: &str) -> Database {
    let conn = Connection::open(path).unwrap();
    for sql in crate::db::migrations::MIGRATIONS.iter().take(5) {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    conn.execute(
        "INSERT INTO hosts(id,name,host,created_at,updated_at) VALUES(?1,'QA','127.0.0.1',0,0)",
        [host],
    )
    .unwrap();
    let mut settings = crate::settings::Settings::default();
    settings
        .network
        .profiles
        .push(crate::network::ProxyProfile {
            id: proxy.into(),
            name: "QA".into(),
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: "qa".into(),
        });
    conn.execute(
        "INSERT INTO settings VALUES('app',?1,0)",
        [serde_json::to_string(&settings).unwrap()],
    )
    .unwrap();
    drop(conn);
    Database::open(path).unwrap()
}

pub(super) fn child(manifest: &std::path::Path, output: &std::path::Path) {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let log = std::fs::File::create(output).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "services::credentials::native::tests::system::isolated_binding_reader_child",
            "--ignored",
        ])
        .env("TUNNELDE_TEST_BINDING_MANIFEST", manifest)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(
                status.success(),
                "isolated binding child failed; log: {}",
                output.display()
            );
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "isolated binding child exceeded its deadline; log: {}",
                output.display()
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
