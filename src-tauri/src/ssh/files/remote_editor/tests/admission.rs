//! Real durable claims must survive an editor's failed staging cleanup.
use super::{workers::*, *};
use crate::ssh::files::native_save::{runtime, testing};

#[derive(Clone)]
struct DurableJournal {
    memory: MemoryJournal,
    native: Arc<runtime::Manager>,
    destination: crate::ssh::session::SessionIdentity,
}
impl Journal for DurableJournal {
    async fn admission(
        &self,
        sftp: &SftpSession,
        _: &str,
        record: &Record,
    ) -> AppResult<Option<runtime::Mutation>> {
        self.native
            .reserve_editor_mutation(
                &self.destination,
                sftp,
                &[record.path.clone(), record.directory.clone()],
                &record.id,
                record.receipt.as_ref().unwrap().generation(),
            )
            .await
    }
    async fn cleanup_admission(
        &self,
        sftp: &SftpSession,
        record: &Record,
    ) -> AppResult<Option<runtime::Mutation>> {
        match &record.admission {
            Some(reference) => self
                .native
                .resume_editor_cleanup(
                    &self.destination,
                    sftp,
                    &[record.path.clone(), record.directory.clone()],
                    (&record.id, record.receipt.as_ref().unwrap().generation()),
                    reference,
                )
                .await
                .map(Some),
            None => self.admission(sftp, "unused", record).await,
        }
    }
    fn create(&self, record: &Record) -> AppResult<()> {
        self.memory.create(record)
    }
    fn persist(&self, record: &Record) -> AppResult<()> {
        self.memory.persist(record)
    }
    fn forget(&self, record: &Record) -> AppResult<()> {
        self.memory.forget(record)
    }
    fn current(&self, record: &Record) -> AppResult<Record> {
        self.memory.current(record)
    }
    fn writable(&self, address: &str, path: &str) -> AppResult<()> {
        self.memory.writable(address, path)
    }
    fn changed(&self) {
        self.memory.changed();
    }
    fn published(&self, session: &str) {
        self.memory.published(session);
    }
}

#[tokio::test]
async fn cleanup_failure_keeps_durable_claim_while_confirmed_cleanup_releases_it() {
    for failed in [false, true] {
        let fixture = Arc::new(Fixture::new());
        if failed {
            *fixture.probe.failure.lock().unwrap() = "remove".into();
        }
        let directory = fixture.root.join("native-file-saves");
        let destination = testing::admission_fixture(&directory);
        let native = Arc::new(runtime::Manager::new(
            &fixture.root,
            "dev.tunnelde.qa.cleanup-claim",
        ));
        let journal = DurableJournal {
            memory: MemoryJournal::default(),
            native: native.clone(),
            destination: destination.clone(),
        };
        let (budget, _) = budget();
        let remote = fixture.clone();
        saving::save_with(
            &budget,
            request(&fixture, "approved"),
            policy::Native,
            move |job| opening(remote, job),
            journal.clone(),
        )
        .await
        .unwrap();
        assert_eq!(fixture.disk(), "approved");
        assert_eq!(
            testing::admission_claim_count(&directory),
            usize::from(failed)
        );
        assert_eq!(
            journal.memory.records.lock().unwrap().len(),
            usize::from(failed)
        );
        if failed {
            let sftp = fixture.client().await;
            assert!(native
                .writable(&destination, &sftp, &["/note.txt"])
                .await
                .is_err());
            sftp.close().await.unwrap();
            // Reconstruct the manager as after a client restart. This must
            // resume the exact durable claim, not reserve a new overlapping one.
            let restored = DurableJournal {
                native: Arc::new(runtime::Manager::new(
                    &fixture.root,
                    "dev.tunnelde.qa.cleanup-claim",
                )),
                ..journal.clone()
            };
            let record = restored.memory.records.lock().unwrap()[0].clone();
            let remote = fixture.clone();
            *fixture.probe.failure.lock().unwrap() = String::new();
            retained::retry_with(
                &budget,
                record,
                move || async move { Ok(remote.client().await) },
                restored.clone(),
            )
            .await
            .unwrap();
            assert!(restored.memory.records.lock().unwrap().is_empty());
            assert_eq!(testing::admission_claim_count(&directory), 0);
            assert_eq!(fixture.disk(), "approved");
        }
    }
}
