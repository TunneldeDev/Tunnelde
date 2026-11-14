use super::*;
use std::process::{Child, Command, Stdio};

pub(super) struct Fixture(pub(super) PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-resource-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    pub(super) fn acquire(&self, roots: &[PathBuf]) -> io::Result<Claim> {
        Claim::in_registry(&self.0.join("registry"), roots)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn nested_roots_aliases_missing_targets_and_partial_claims_are_exclusive() {
    let f = Fixture::new();
    let shared = f.0.join("data/shared");
    std::fs::create_dir_all(&shared).unwrap();
    let roots = [shared.clone(), f.0.join("future/subdir")];
    let owner = f.acquire(&roots).unwrap();
    for root in [
        &shared,
        &shared.join("nested"),
        &shared.join("."),
        &f.0.join("future"),
    ] {
        assert!(f
            .acquire(std::slice::from_ref(root))
            .is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock));
    }
    assert!(f
        .acquire(&[f.0.join("data")])
        .is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock));
    let unrelated = f.0.join("unrelated");
    assert!(f.acquire(&[unrelated.clone(), shared]).is_err());
    // A rejected multi-root request must not retain a partial claim.
    let independent = f.acquire(&[unrelated]).unwrap();
    drop(independent);
    drop(owner);
    let reused = f.acquire(&roots).unwrap();
    drop(reused);
    // Acquisition lazily removes all dead records, leaving one inert record.
    assert_eq!(std::fs::read_dir(f.0.join("registry")).unwrap().count(), 2);
}

#[cfg(windows)]
#[test]
fn windows_case_aliases_cannot_claim_the_same_directory() {
    let f = Fixture::new();
    let root = f.0.join("MixedCase");
    std::fs::create_dir(&root).unwrap();
    let owner = f.acquire(std::slice::from_ref(&root)).unwrap();
    let alternate = PathBuf::from(root.to_string_lossy().to_uppercase());
    assert!(f
        .acquire(&[alternate])
        .is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock));
    drop(owner);
}

#[cfg(unix)]
#[test]
fn unix_parent_aliases_and_insecure_registries_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    let root = f.0.join("data");
    std::fs::create_dir(&root).unwrap();
    let alias = f.0.join("alias");
    symlink(&root, &alias).unwrap();
    let owner = f.acquire(&[root.join("missing")]).unwrap();
    assert!(f
        .acquire(&[alias.join("missing/child")])
        .is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock));
    assert!(f.acquire(&[alias]).is_err());
    drop(owner);
    let registry = f.0.join("registry");
    std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(f
        .acquire(std::slice::from_ref(&root))
        .is_err_and(|e| e.kind() == io::ErrorKind::InvalidData));
    std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::remove_dir_all(&registry).unwrap();
    symlink(&root, &registry).unwrap();
    assert!(f.acquire(&[root]).is_err());
}

#[test]
fn registry_and_invalid_active_records_fail_without_modifying_resources() {
    let f = Fixture::new();
    let registry = f.0.join("registry");
    let root = f.0.join("data");
    assert!(f.acquire(std::slice::from_ref(&registry)).is_err());
    let path = registry.join(format!("{}.json", uuid::Uuid::new_v4()));
    let invalid = Lease::open(&path, true).unwrap();
    (&invalid._file).write_all(b"invalid record").unwrap();
    assert!(f.acquire(std::slice::from_ref(&root)).is_err());
    assert!(!root.exists());
    drop(invalid);
    let recovered = f.acquire(&[root]).unwrap();
    drop(recovered);
}

#[test]
fn concurrent_allocators_admit_exactly_one_owner() {
    let f = Fixture::new();
    let root = f.0.join("data");
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    f.acquire(std::slice::from_ref(&root))
                })
            })
            .collect();
        // Keep all returned claims alive until every contender has finished.
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.kind() == io::ErrorKind::WouldBlock));
    });
    let reused = f.acquire(&[root]).unwrap();
    drop(reused);
}

struct Worker(Child);
impl Worker {
    fn start(f: &Fixture, root: &Path) -> Self {
        Self::start_mode(f, root, false)
    }
    fn start_mode(f: &Fixture, root: &Path, startup: bool) -> Self {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage::ownership::resources::tests::claim_child",
                "--ignored",
                "--nocapture",
            ])
            .env("TUNNELDE_CLAIM_TEST_FIXTURE", &f.0)
            .env("TUNNELDE_CLAIM_TEST_ROOT", root)
            .env(
                "TUNNELDE_CLAIM_TEST_STARTUP",
                if startup { "yes" } else { "no" },
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut worker = Self(child);
        let deadline = Instant::now() + Duration::from_secs(15);
        while !f.0.join("ready").exists() {
            assert!(
                worker.0.try_wait().unwrap().is_none(),
                "Claim child exited before readiness"
            );
            assert!(Instant::now() < deadline, "Claim child readiness timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
        worker
    }
    fn finish(&mut self) {
        self.0.stdin.take().unwrap().write_all(b"q").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "Claim child exit timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "subprocess fixture; exercised by resource ownership tests"]
fn claim_child() {
    let Some(fixture) = std::env::var_os("TUNNELDE_CLAIM_TEST_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("TUNNELDE_CLAIM_TEST_ROOT").unwrap());
    let fixture = PathBuf::from(fixture);
    let _startup = (std::env::var("TUNNELDE_CLAIM_TEST_STARTUP").unwrap() == "yes").then(|| {
        crate::storage::ownership::initialize(root.clone(), fixture.join("child-logs"), None)
            .unwrap()
    });
    let _claim = _startup
        .is_none()
        .then(|| Claim::in_registry(&fixture.join("registry"), &[root]).unwrap());
    std::fs::write(fixture.join("ready"), b"ready").unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
}

#[test]
fn real_process_owner_blocks_overlaps_until_exit_or_crash() {
    for crash in [false, true] {
        let f = Fixture::new();
        let root = f.0.join("data");
        let mut worker = Worker::start(&f, &root);
        assert!(f
            .acquire(&[root.join("nested")])
            .is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock));
        let independent = f.acquire(&[f.0.join("other-data")]).unwrap();
        drop(independent);
        if crash {
            worker.0.kill().unwrap();
            worker.0.wait().unwrap();
        } else {
            worker.finish();
        }
        let reused = f.acquire(&[root]).unwrap();
        drop(reused);
    }
}

#[test]
fn different_process_homes_exclude_every_shared_category_without_touching_config() {
    use crate::storage::{config, layout::CATEGORIES, ownership};
    for category in CATEGORIES {
        let f = Fixture::new();
        let shared = f.0.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::write(shared.join("retained"), b"content").unwrap();
        let mut config = config::Config::default();
        config.locations.insert(category, shared.clone());
        let first = f.0.join("first");
        let second = f.0.join("second");
        config::save(&first, &config).unwrap();
        config::save(&second, &config).unwrap();
        let before = std::fs::read(second.join("storage.json")).unwrap();
        let mut child = Worker::start_mode(&f, &first, true);
        assert!(
            ownership::initialize(second.clone(), f.0.join("parent-logs"), None)
                .is_err_and(|error| error.to_string().contains("overlapping storage location")),
            "{category:?}"
        );
        assert_eq!(std::fs::read(second.join("storage.json")).unwrap(), before);
        assert_eq!(std::fs::read(shared.join("retained")).unwrap(), b"content");
        child.finish();
        let (_, owner) = ownership::initialize(second, f.0.join("parent-logs"), None).unwrap();
        drop(owner);
    }
}

#[test]
fn actual_startup_blocks_shared_categories_and_preserves_pending_migration() {
    use crate::storage::{
        config,
        layout::{Category, Paths},
        migration, ownership,
    };
    let f = Fixture::new();
    let home = f.0.join("home");
    let source = home.join("plugin-data");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("draft"), b"retained").unwrap();
    let paths = Paths::new(home.clone(), f.0.join("logs"), &Default::default(), None);
    let target = f.0.join("target");
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        vec![config::Change {
            category: Category::PluginData,
            target: target.clone(),
            migrate: true,
        }],
    )
    .unwrap();
    let before = std::fs::read(home.join("storage.json")).unwrap();
    let other = f.0.join("other-home");
    std::fs::create_dir(&other).unwrap();
    let mut other_config = config::Config::default();
    other_config
        .locations
        .insert(Category::PluginData, target.clone());
    config::save(&other, &other_config).unwrap();
    let (_, owner) = ownership::initialize(other.clone(), f.0.join("other-logs"), None).unwrap();
    assert!(ownership::initialize(home.clone(), f.0.join("logs"), None)
        .is_err_and(|e| e.to_string().contains("overlapping storage location")));
    assert_eq!(std::fs::read(home.join("storage.json")).unwrap(), before);
    assert!(!target.exists());
    assert_eq!(std::fs::read(source.join("draft")).unwrap(), b"retained");
    drop(owner);
    let (active, owner) = ownership::initialize(home.clone(), f.0.join("logs"), None).unwrap();
    assert_eq!(
        active.dir(Category::PluginData),
        target.canonicalize().unwrap()
    );
    assert_eq!(std::fs::read(target.join("draft")).unwrap(), b"retained");
    assert!(config::load(&home).unwrap().pending.is_none());
    assert!(ownership::initialize(other, f.0.join("other-logs"), None).is_err());
    drop(owner);
}

#[test]
fn independent_homes_can_initialize_while_another_process_is_running() {
    let f = Fixture::new();
    let mut child = Worker::start_mode(&f, &f.0.join("first"), true);
    let (_, owner) =
        crate::storage::ownership::initialize(f.0.join("second"), f.0.join("parent-logs"), None)
            .unwrap();
    child.finish();
    drop(owner);
}

#[test]
fn occupied_categories_cannot_be_mutated_by_creating_a_new_bootstrap_home() {
    use crate::storage::{config, layout::Category, ownership};
    let f = Fixture::new();
    let shared = f.0.join("shared");
    let first = f.0.join("first-home");
    let mut config = config::Config::default();
    config
        .locations
        .insert(Category::PluginData, shared.clone());
    config::save(&first, &config).unwrap();
    let (_, owner) = ownership::initialize(first, f.0.join("first-logs"), None).unwrap();
    assert!(!shared.exists());
    for home in [shared.clone(), shared.join("nested")] {
        assert!(ownership::initialize(home, f.0.join("other-logs"), None).is_err());
        assert!(
            !shared.exists(),
            "bootstrap created files inside another owner's category"
        );
    }
    drop(owner);
}

#[test]
fn failed_migration_retains_destination_claim_until_process_owner_drops() {
    use crate::storage::{config, layout::Category, ownership};
    let f = Fixture::new();
    let home = f.0.join("home");
    let target = f.0.join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("foreign"), b"retain").unwrap();
    let mut config = config::Config {
        pending: Some(config::Pending {
            id: uuid::Uuid::new_v4().to_string(),
            changes: vec![config::Change {
                category: Category::PluginData,
                target: target.clone(),
                migrate: true,
            }],
            action: config::Action::Apply,
            restart_requested: true,
        }),
        ..Default::default()
    };
    config::save(&home, &config).unwrap();
    let (paths, owner) = ownership::initialize(home.clone(), f.0.join("logs"), None).unwrap();
    config = config::load(&home).unwrap();
    assert!(config
        .last_error
        .unwrap()
        .contains("storage.targetNotEmpty"));
    assert!(!config.pending.unwrap().restart_requested);
    assert_eq!(paths.dir(Category::PluginData), home.join("plugin-data"));
    let other = f.0.join("other");
    let mut config = config::Config::default();
    config
        .locations
        .insert(Category::PluginData, target.clone());
    config::save(&other, &config).unwrap();
    assert!(ownership::initialize(other.clone(), f.0.join("other-logs"), None).is_err());
    assert_eq!(std::fs::read(target.join("foreign")).unwrap(), b"retain");
    drop(owner);
    let (_, owner) = ownership::initialize(other, f.0.join("other-logs"), None).unwrap();
    drop(owner);
}

#[test]
fn invalid_pending_plans_report_recovery_without_preventing_current_data_startup() {
    use crate::storage::{config, layout::Category, ownership};
    for invalid_id in [false, true] {
        let f = Fixture::new();
        let home = f.0.join("home");
        let current = home.join("plugin-data");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("draft"), b"retain").unwrap();
        let config = config::Config {
            pending: Some(config::Pending {
                id: if invalid_id {
                    "invalid".into()
                } else {
                    uuid::Uuid::new_v4().to_string()
                },
                changes: vec![config::Change {
                    category: Category::PluginData,
                    target: if invalid_id {
                        f.0.join("target")
                    } else {
                        PathBuf::from("relative")
                    },
                    migrate: true,
                }],
                action: config::Action::Apply,
                restart_requested: true,
            }),
            ..Default::default()
        };
        config::save(&home, &config).unwrap();
        let (paths, owner) = ownership::initialize(home.clone(), f.0.join("logs"), None).unwrap();
        let retained = config::load(&home).unwrap();
        assert!(retained.last_error.is_some());
        let pending = retained.pending.unwrap();
        assert!(!pending.restart_requested);
        assert_eq!(pending.id, config.pending.unwrap().id);
        assert_eq!(paths.dir(Category::PluginData), current);
        assert_eq!(std::fs::read(current.join("draft")).unwrap(), b"retain");
        assert!(!f.0.join("target").exists());
        drop(owner);
    }
}

#[test]
fn cancelling_a_new_plan_reserves_its_target_without_conflicting_with_own_claim() {
    use crate::storage::{config, layout::Category, migration, ownership};
    let f = Fixture::new();
    let home = f.0.join("home");
    let (paths, owner) = ownership::initialize(home.clone(), f.0.join("logs"), None).unwrap();
    let target = f.0.join("target");
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        vec![config::Change {
            category: Category::PluginData,
            target: target.clone(),
            migrate: true,
        }],
    )
    .unwrap();
    let before = std::fs::read(home.join("storage.json")).unwrap();
    let other = f.0.join("other-home");
    let mut foreign = config::Config::default();
    foreign.locations.insert(Category::PluginData, target);
    config::save(&other, &foreign).unwrap();
    let (_, occupied) = ownership::initialize(other, f.0.join("other-logs"), None).unwrap();
    assert!(owner.cancel(&paths, &mut config).is_err());
    assert_eq!(std::fs::read(home.join("storage.json")).unwrap(), before);
    assert_eq!(
        config.pending.as_ref().unwrap().action,
        config::Action::Apply
    );
    drop(occupied);
    owner.cancel(&paths, &mut config).unwrap();
    assert!(config::load(&home).unwrap().pending.is_none());
    drop(owner);
}

#[test]
fn migration_staging_and_reset_archives_are_reserved_before_startup_mutation() {
    use crate::storage::{config, layout::Category, migration, ownership, restore};
    for recovery in [false, true] {
        let f = Fixture::new();
        let home = f.0.join("home");
        let logs = f.0.join("logs");
        let mut config = config::Config::default();
        if recovery {
            config
                .locations
                .insert(Category::PluginData, f.0.join("source"));
        }
        let target = if recovery {
            home.join("plugin-data")
        } else {
            f.0.join("target")
        };
        let change = config::Change {
            category: Category::PluginData,
            target: target.clone(),
            migrate: true,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let occupied = if recovery {
            restore::backup_root(Category::PluginData, &target)
                .unwrap()
                .join(&id)
        } else {
            migration::stage(&change, &id).unwrap()
        };
        config.pending = Some(config::Pending {
            id,
            changes: vec![change],
            action: config::Action::Apply,
            restart_requested: true,
        });
        config::save(&home, &config).unwrap();
        let before = std::fs::read(home.join("storage.json")).unwrap();
        let other = f.0.join("other-home");
        let mut other_config = config::Config::default();
        other_config
            .locations
            .insert(Category::PluginData, occupied);
        config::save(&other, &other_config).unwrap();
        let (_, owner) = ownership::initialize(other, f.0.join("other-logs"), None).unwrap();
        assert!(ownership::initialize(home.clone(), logs, None).is_err());
        assert_eq!(std::fs::read(home.join("storage.json")).unwrap(), before);
        assert!(!target.exists());
        drop(owner);
    }
}
