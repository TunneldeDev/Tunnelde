//! Final policy admission occurs after disk dispatch, never before it.
use super::mutation::{cancellation, journal, setup};
use super::*;
use crate::ssh::files::native_save::journal::admission::{Kind, Phase};

#[tokio::test]
async fn final_policy_sees_durable_dispatch_and_rejection_never_polls_remote_work() {
    for with_store in [false, true] {
        let (fixture, destination) = setup();
        if !with_store {
            std::fs::remove_dir_all(fixture.0.join("native-file-saves")).unwrap();
        }
        let manager = fixture.manager();
        let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
        let (job, _delivery) = cancellation();
        let error = manager
            .mutate_checked(
                &destination,
                &sftp,
                Kind::Delete,
                &["/requested".into()],
                &job,
                (
                    || {
                        if with_store {
                            let claims = journal(&fixture).legacy_claims().unwrap();
                            assert_eq!(claims.len(), 1);
                            assert!(claims[0].phase == Phase::Dispatched);
                        }
                        Err(AppError::validation("pluginSecurity.changed"))
                    },
                    |_| async { panic!("revoked worker was polled") },
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "pluginSecurity.changed");
        if with_store {
            assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
        } else {
            assert!(!fixture.0.join("native-file-saves").exists());
        }
        sftp.close().await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_after_disk_checkpoint_releases_only_proven_unsent_work() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let (job, delivery) = cancellation();
    let error = manager
        .mutate_checked(
            &destination,
            &sftp,
            Kind::Mkdir,
            &["/requested".into()],
            &job,
            (
                || {
                    assert!(
                        journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Dispatched
                    );
                    drop(delivery);
                    job.commit()
                },
                |_| async { panic!("cancelled worker was polled") },
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "cancelled");
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn canonical_alias_changed_after_checkpoint_never_reaches_policy_or_remote_work() {
    use russh_sftp::protocol::{File, FileAttributes, Name};
    struct ChangingAlias(usize);
    impl russh_sftp::server::Handler for ChangingAlias {
        type Error = StatusCode;
        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }
        async fn realpath(&mut self, id: u32, _: String) -> Result<Name, StatusCode> {
            self.0 += 1;
            let path = if self.0 == 1 {
                "/workspace/actual"
            } else {
                "/workspace/changed"
            };
            Ok(Name {
                id,
                files: vec![File::new(path, FileAttributes::empty())],
            })
        }
    }
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (client, stream) = tokio::io::duplex(8192);
    russh_sftp::server::run(stream, ChangingAlias(0)).await;
    let sftp = SftpSession::new(client).await.unwrap();
    let (job, _delivery) = cancellation();
    let error = manager
        .mutate_checked(
            &destination,
            &sftp,
            Kind::Mkdir,
            &["/requested".into()],
            &job,
            (
                || -> AppResult<()> { panic!("changed target reached final admission") },
                |_| async { panic!("changed target mutated") },
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "editor.nativeChanged");
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}
