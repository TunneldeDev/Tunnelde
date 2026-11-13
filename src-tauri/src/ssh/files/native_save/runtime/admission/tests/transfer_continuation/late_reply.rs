//! A temporarily pending original reply must not discard the live task permit.
use super::*;
use russh_sftp::protocol::Status;

struct DelayedDirectory {
    arrived: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

impl russh_sftp::server::Handler for DelayedDirectory {
    type Error = StatusCode;

    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }

    async fn realpath(&mut self, id: u32, _: String) -> Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: vec![File::new("/workspace/actual", FileAttributes::empty())],
        })
    }

    async fn mkdir(&mut self, _: u32, _: String, _: FileAttributes) -> Result<Status, StatusCode> {
        self.arrived.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        Err(StatusCode::PermissionDenied)
    }
}

#[tokio::test]
async fn pending_terminal_reply_keeps_the_original_worker_until_it_can_park() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let arrived = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (client, stream) = tokio::io::duplex(8192);
    russh_sftp::server::run(
        stream,
        DelayedDirectory {
            arrived: arrived.clone(),
            release: release.clone(),
        },
    )
    .await;
    let sftp = SftpSession::new(client).await.unwrap();
    let roots = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &roots,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let initial = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let reference = initial.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let mut attempt = initial.dispatch_transfer(&reference, &job).await.unwrap();
    let observation = attempt.observation();
    let request = observation.request(sftp.create_dir("/requested"));
    tokio::pin!(request);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        tokio::select! {
            _ = arrived.acquire() => {},
            result = request.as_mut() => panic!("reply was not held: {result:?}"),
        }
    })
    .await
    .unwrap();
    assert!(attempt.park().await.is_err());
    assert!(attempt.settle().await.is_err());
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert!(claims[0].phase == Phase::Dispatched);
    assert!(manager.pending().await.iter().any(|task| task.running));
    release.add_permits(1);
    assert!(request.await.is_err(), "the original peer rejected MKDIR");
    assert!(observation.settled());
    let parked = attempt.park().await.unwrap();
    assert!(attempt.park().await.is_err(), "the permit is single-use");
    assert!(attempt.settle().await.is_err());
    assert!(attempt
        .extend_paths(&destination, &sftp, &["/later".into()])
        .await
        .is_err());
    assert!(!manager.pending().await.iter().any(|task| task.running));
    manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap()
        .dispatch_transfer(&parked, &job)
        .await
        .unwrap()
        .settle()
        .await
        .unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}
