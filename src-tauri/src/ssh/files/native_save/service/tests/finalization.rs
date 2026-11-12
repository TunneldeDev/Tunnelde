use super::*;

#[tokio::test]
async fn abandoned_reservation_is_durable_before_secret_deletion_and_retries_without_dispatch() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    secrets.unavailable.store(true, Ordering::Release);
    assert!(service.finalize(&ready).await.is_err());
    let abandoned = service.records().await.unwrap().pop().unwrap();
    assert!(abandoned.stage == Stage::Abandoned);
    assert!(secrets
        .values
        .lock()
        .unwrap()
        .contains_key(&ready.secret_key()));
    let client = client(&fixture, &authority, vec![]);
    assert!(service
        .submit(&ready, &prepared, &client, |_| Ok(()))
        .await
        .is_err());
    assert!(client.test_transport().requests.lock().unwrap().is_empty());
    drop(service);
    secrets.unavailable.store(false, Ordering::Release);
    let restored = Service::new(Journal::open(&fixture.path()).unwrap(), secrets.clone());
    restored.finalize(&abandoned).await.unwrap();
    assert!(restored.records().await.unwrap().is_empty());
    assert!(!secrets
        .values
        .lock()
        .unwrap()
        .contains_key(&ready.secret_key()));
}

#[tokio::test]
async fn unknown_and_retained_backups_are_never_forgotten_or_stripped_of_credentials() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    let client = client(
        &fixture,
        &authority,
        vec![
            Err(lost()),
            Ok(response(&authority, Some(&prepared.control), "conflict", 4)),
        ],
    );
    assert!(service
        .submit(&ready, &prepared, &client, |_| Ok(()))
        .await
        .is_err());
    let unknown = service.records().await.unwrap().pop().unwrap();
    assert!(service.finalize(&unknown).await.is_err());
    let settled = service
        .recover(&unknown, &client, |_| Ok(()))
        .await
        .unwrap();
    assert!(service.finalize(&settled).await.is_err());
    assert!(secrets
        .values
        .lock()
        .unwrap()
        .contains_key(&ready.secret_key()));
    assert!(service.records().await.unwrap()[0] == settled);
}

#[tokio::test]
async fn confirmed_release_can_retire_and_reuse_capacity_without_remote_replay() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    let client = client(
        &fixture,
        &authority,
        vec![
            Ok(response(
                &authority,
                Some(&prepared.control),
                "succeeded",
                3,
            )),
            Ok(response(&authority, Some(&prepared.control), "released", 4)),
        ],
    );
    let settled = service
        .submit(&ready, &prepared, &client, |_| Ok(()))
        .await
        .unwrap();
    let released = service
        .release(&settled, &client, false, |_| Ok(()))
        .await
        .unwrap();
    service.finalize(&released).await.unwrap();
    assert!(service.records().await.unwrap().is_empty());
    assert!(secrets.values.lock().unwrap().is_empty());
    assert_eq!(client.test_transport().requests.lock().unwrap().len(), 2);
    for _ in 0..130 {
        let prepared = crate::ssh::files::native_save::testing::prepared(&authority);
        let ready = service
            .reserve(binding(&authority, &prepared), &prepared)
            .await
            .unwrap();
        service.finalize(&ready).await.unwrap();
    }
    assert!(service.records().await.unwrap().is_empty());
}

#[tokio::test]
async fn changed_credential_during_retirement_is_preserved_with_the_terminal_record() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    secrets
        .values
        .lock()
        .unwrap()
        .insert(ready.secret_key(), "0".repeat(64));
    assert!(matches!(
        service.finalize(&ready).await,
        Err(journal::Error::SecretChanged)
    ));
    let records = service.records().await.unwrap();
    assert!(records[0].stage == Stage::Abandoned);
    assert_eq!(
        secrets.values.lock().unwrap().get(&ready.secret_key()),
        Some(&"0".repeat(64))
    );
}
