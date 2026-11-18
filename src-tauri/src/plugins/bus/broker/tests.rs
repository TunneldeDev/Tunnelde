use super::*;

fn peer(id: &str, generation: u64) -> Peer {
    Peer {
        id: id.into(),
        generation,
    }
}

#[test]
fn online_discovery_and_retirement_are_generation_scoped() {
    let mut book = Book::default();
    let a = peer("a", 1);
    let b = peer("b", 2);
    book.advertise(&a, "mounts".into(), Some(2)).unwrap();
    book.subscribe(&b, None, DISCOVERY.into(), true).unwrap();
    assert_eq!(
        book.discover(&b, "mounts").unwrap(),
        json!([{"pluginId":"a","version":2}])
    );
    book.retire_before("a", 2);
    assert_eq!(book.discover(&b, "mounts").unwrap(), json!([]));
    let removal = book.drain(&b).unwrap();
    assert!(removal["messages"][0]["payload"]["version"].is_null());
    assert_eq!(removal["messages"][0]["topic"], DISCOVERY);
}

#[test]
fn private_traffic_requires_live_membership_and_an_exact_invitation() {
    let mut book = Book::default();
    let a = peer("a", 1);
    let b = peer("b", 1);
    let c = peer("c", 1);
    let id = book.create(&a).unwrap();
    book.signal(&b).unwrap();
    book.subscribe(&c, None, "progress".into(), true).unwrap();
    assert!(book
        .subscribe(&c, Some(&id), "progress".into(), true)
        .is_err());
    assert!(book
        .publish(&c, Some(&id), "progress".into(), json!(1))
        .is_err());
    assert!(book.invite(&c, &id, "b").is_err());
    let invite = book.invite(&a, &id, "b").unwrap();
    assert_eq!(book.invitations(&c).unwrap(), json!([]));
    assert!(book.join(&c, &invite).is_err());
    assert!(book.join(&peer("b", 2), &invite).is_err());
    assert_eq!(book.join(&b, &invite).unwrap(), id);
    assert!(book.join(&b, &invite).is_err());
    book.subscribe(&b, Some(&id), "progress".into(), true)
        .unwrap();
    assert_eq!(
        book.publish(&a, Some(&id), "progress".into(), json!({"pluginId":"c"}))
            .unwrap(),
        1
    );
    let received = book.drain(&b).unwrap();
    assert_eq!(received["messages"][1]["sender"]["pluginId"], "a");
    assert_eq!(book.drain(&c).unwrap()["messages"], json!([]));
    book.publish(&a, Some(&id), "progress".into(), json!("stale"))
        .unwrap();
    book.retire_before("a", 2);
    let received = book.drain(&b).unwrap();
    assert_eq!(received["messages"].as_array().unwrap().len(), 1);
    assert_eq!(received["messages"][0]["topic"], CLOSED);
    assert!(book
        .publish(&b, Some(&id), "progress".into(), json!({}))
        .is_err());
}

#[tokio::test]
async fn wake_is_buffered_and_queue_reports_overflow() {
    let mut book = Book::default();
    let a = peer("a", 1);
    let b = peer("b", 1);
    let id = book.create(&a).unwrap();
    let signal = book.signal(&b).unwrap();
    let invitation = book.invite(&a, &id, "b").unwrap();
    book.join(&b, &invitation).unwrap();
    book.drain(&b).unwrap();
    book.subscribe(&b, Some(&id), "progress".into(), true)
        .unwrap();
    for i in 0..(QUEUE + 3) {
        book.publish(&a, Some(&id), "progress".into(), json!(i))
            .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(1), signal.ready.notified())
        .await
        .unwrap();
    let batch = book.drain(&b).unwrap();
    assert_eq!(batch["lost"], 3);
    assert_eq!(batch["messages"][0]["payload"], 3);
    assert_eq!(batch["messages"].as_array().unwrap().len(), 32);
    assert_eq!(book.drain(&b).unwrap()["lost"], 0);
}
