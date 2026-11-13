//! Explicit consent is required by the caller before creating local authority.
use super::*;
use std::io::Write;

fn marker(directory: &Path) -> journal::Result<PathBuf> {
    Ok(directory
        .parent()
        .ok_or(journal::Error::Unrecognized)?
        .join("native-file-saves.initialized"))
}
pub(super) fn marked(directory: &Path) -> journal::Result<bool> {
    crate::storage::layout::metadata(&marker(directory)?)
        .map(|value| value.is_some())
        .map_err(|_| journal::Error::Unavailable)
}
fn mark(directory: &Path) -> journal::Result<()> {
    let path = marker(directory)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| journal::Error::Unavailable)?;
    file.write_all(b"Tunnelde native saves v1\n")
        .and_then(|()| file.sync_all())
        .map_err(|_| journal::Error::Unavailable)?;
    #[cfg(unix)]
    std::fs::File::open(directory.parent().ok_or(journal::Error::Unrecognized)?)
        .and_then(|parent| parent.sync_all())
        .map_err(|_| journal::Error::Unavailable)?;
    Ok(())
}

impl Manager {
    pub(in crate::ssh::files::native_save) async fn initialize(
        &self,
    ) -> journal::Result<Arc<Service<System>>> {
        let mut current = self.service.lock().await;
        let directory = self.directory.clone();
        let application = self.application.clone();
        let observed = self.observed.clone();
        let cached = current.clone();
        let permit = self
            .io
            .clone()
            .try_acquire_owned()
            .map_err(|_| journal::Error::Capacity)?;
        let service = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let secrets = System::new(&application)?;
            let exists = crate::storage::layout::metadata(&directory)
                .map_err(|_| journal::Error::Unavailable)?
                .is_some();
            let previous = marked(&directory)?;
            if !exists && (previous || observed.load(Ordering::Acquire) || cached.is_some()) {
                return Err(journal::Error::Changed);
            }
            // Persist outside the recovery directory BEFORE creating authority.
            // Removing that directory cannot silently reset it on the next launch.
            // A partial first initialization is diagnostic, never auto-repaired.
            if !previous {
                mark(&directory)?;
            }
            observed.store(true, Ordering::Release);
            if let Some(service) = cached {
                return Ok(service);
            }
            let journal = if exists {
                journal::Journal::open(&directory)?
            } else {
                journal::Journal::create(&directory)?
            };
            Ok(Arc::new(Service::new(journal, secrets)))
        })
        .await
        .map_err(|_| journal::Error::Unavailable)??;
        // Use the same live service for shared legacy/native admission.
        service.enable_setups().await?;
        *current = Some(service.clone());
        Ok(service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn explicit_initialization_is_shared_and_missing_store_cannot_reset_after_restart() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-setup-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let manager = Manager::new(&root, "qa.native.initialization");
        assert!(manager.pending().await.is_empty());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let first = manager.initialize().await.unwrap();
        let second = manager.initialize().await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(first.admission_enabled().await.unwrap());
        assert!(first.setups().await.unwrap().is_empty());
        drop(first);
        drop(second);
        drop(manager);
        // Only an isolated fixture is removed; the durable external marker stays.
        std::fs::remove_dir_all(root.join("native-file-saves")).unwrap();
        let restarted = Manager::new(&root, "qa.native.initialization");
        assert_eq!(restarted.pending().await.len(), 1);
        assert!(matches!(
            restarted.initialize().await,
            Err(journal::Error::Changed)
        ));
        assert!(!root.join("native-file-saves").exists());
        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn partial_initialization_remains_visible_without_creating_a_replacement() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-setup-partial-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let directory = root.join("native-file-saves");
        mark(&directory).unwrap();
        let manager = Manager::new(&root, "qa.native.partial");
        assert!(manager.initialize().await.is_err());
        assert_eq!(manager.pending().await.len(), 1);
        assert!(!directory.exists());
        drop(manager);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn setup_ready_requires_original_context_and_never_hides_pending_installation() {
        use super::super::super::{
            journal::Owner,
            testing::{authority, setup_plan},
        };
        let root =
            std::env::temp_dir().join(format!("tunnelde-setup-context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let manager = Manager::new(&root, "qa.native.context");
        let plan = setup_plan();
        assert!(!manager.ready_setup(&plan).await.unwrap());
        let service = manager.initialize().await.unwrap();
        let reserved = service
            .reserve_setup(
                Owner {
                    id: uuid::Uuid::new_v4().to_string(),
                    generation: uuid::Uuid::new_v4().to_string(),
                },
                plan.clone(),
            )
            .await
            .unwrap();
        assert!(manager.ready_setup(&plan).await.is_err());
        let permit = service.dispatch_setup(&reserved).await.unwrap();
        assert!(manager.ready_setup(&plan).await.is_err());
        service.complete_setup(permit, authority()).await.unwrap();
        assert!(manager.ready_setup(&plan).await.unwrap());
        let mut alias = plan.clone();
        alias.destination.host_id = "a-second-saved-host-for-the-same-authenticated-target".into();
        assert!(manager.ready_setup(&alias).await.unwrap());
        alias.context.account = "different-account".into();
        assert!(!manager.ready_setup(&alias).await.unwrap());
        drop(service);
        drop(manager);
        let reopened = Manager::new(&root, "qa.native.context");
        assert!(reopened.ready_setup(&plan).await.unwrap());
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
