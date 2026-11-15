use super::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-local-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn real_file_operations_preserve_create_new_listing_and_delete_semantics() {
    let root = Root::new();
    let directory = root.path().join("owned");
    let path = directory.to_string_lossy().into_owned();
    mkdir(path.clone()).await.unwrap();
    let file = directory.join("existing.txt");
    let name = file.to_string_lossy().into_owned();
    create_file(name.clone()).await.unwrap();
    std::fs::write(&file, b"must survive duplicate create").unwrap();
    assert!(create_file(name).await.is_err());
    assert_eq!(
        std::fs::read(&file).unwrap(),
        b"must survive duplicate create"
    );
    let listing = list(Some(path.clone())).await.unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].name, "existing.txt");
    assert!(!listing.entries[0].is_dir);
    delete(path.clone(), true).await.unwrap();
    assert!(!directory.exists());
    assert!(list(Some(path)).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn deleting_a_directory_symlink_preserves_its_target() {
    let root = Root::new();
    let target = root.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("retained"), b"retained").unwrap();
    let link = root.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    delete(link.to_string_lossy().into_owned(), true)
        .await
        .unwrap();
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(std::fs::read(target.join("retained")).unwrap(), b"retained");
}

#[tokio::test(flavor = "current_thread")]
async fn admitted_io_leaves_runtime_free_and_retains_capacity_after_caller_loss() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let owner = std::thread::current().id();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = budget.clone();
    let request = tokio::spawn(async move {
        run(&worker, move || {
            started.send(std::thread::current().id()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    assert_ne!(
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap(),
        owner
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    })
    .await
    .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        run(&budget, || Ok(())).await.unwrap_err().to_string(),
        "sftp.localBusy"
    );
    release.send(()).unwrap();
    wait_for_capacity(&capacity).await;
}

#[test]
fn cancelled_queued_create_does_not_touch_the_filesystem() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let root = Root::new();
    let path = root.path().join("must-not-appear");
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        ready.await.unwrap();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
        let worker = budget.clone();
        let name = path.to_string_lossy().into_owned();
        let request =
            tokio::spawn(async move { run(&worker, move || files::local_create_file(name)).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        blocker.await.unwrap();
        wait_for_capacity(&capacity).await;
        assert!(!path.exists());
    });
}

async fn wait_for_capacity(capacity: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
