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

#[test]
fn snapshots_and_membership_hints_are_private_and_follow_runtime_lifetime() {
    let mut book = Book::default();
    let owner = peer("owner", 1);
    let member = peer("guest", 1);
    let outsider = peer("other", 1);
    let channel = book.create(&owner).unwrap();
    let hidden = book.create(&outsider).unwrap();
    book.subscribe(&outsider, None, MEMBERS_CHANGED.into(), true)
        .unwrap();
    book.subscribe(&owner, Some(&channel), MEMBERS_CHANGED.into(), true)
        .unwrap();
    book.subscribe(&member, None, "hello".into(), true).unwrap();
    let invitation = book.invite(&owner, &channel, &member.id).unwrap();
    assert_eq!(
        book.snapshot(&member).unwrap(),
        json!({"publicTopics":["hello"],"channels":[]})
    );
    book.join(&member, &invitation).unwrap();
    let hint = json!({"topic":MEMBERS_CHANGED,"busId":channel,"sender":null,"payload":null});
    assert_eq!(book.drain(&owner).unwrap()["messages"], json!([hint]));
    let snapshot = book.snapshot(&member).unwrap();
    assert_eq!(
        snapshot["channels"],
        json!([{ "busId":channel, "ownerPluginId":"owner", "members":["guest","owner"], "topics":[] }])
    );
    assert_eq!(
        book.snapshot(&outsider).unwrap()["channels"][0]["busId"],
        hidden
    );
    assert_eq!(book.drain(&outsider).unwrap()["messages"], json!([]));
    book.leave(&member, &channel, false).unwrap();
    assert_eq!(book.drain(&owner).unwrap()["messages"], json!([hint]));
    assert_eq!(book.snapshot(&member).unwrap()["channels"], json!([]));
    let invite = book.invite(&owner, &channel, &member.id).unwrap();
    book.join(&member, &invite).unwrap();
    book.retire_before(&member.id, 2);
    assert_eq!(book.drain(&owner).unwrap()["messages"], json!([hint, hint]));
    assert_eq!(
        book.snapshot(&owner).unwrap()["channels"][0]["members"],
        json!(["owner"])
    );
    assert_eq!(
        book.snapshot(&peer("guest", 2)).unwrap(),
        json!({"publicTopics":[],"channels":[]})
    );
    book.leave(&owner, &channel, true).unwrap();
    assert_eq!(book.snapshot(&owner).unwrap()["channels"], json!([]));
}

#[test]
fn invitation_caps_are_independent_and_decline_releases_only_the_recipients_offer() {
    let mut book = Book::default();
    let owner = peer("owner", 1);
    let guest = peer("guest", 1);
    let outsider = peer("outsider", 1);
    let id = book.create(&owner).unwrap();
    book.signal(&guest).unwrap();
    // Fill all but one slot on the channel. Offers to this guest from other
    // channels must not consume that last slot.
    for n in 0..15 {
        let p = peer(&format!("peer-{n}"), 1);
        book.signal(&p).unwrap();
        book.invite(&owner, &id, &p.id).unwrap();
        let other = book.create(&p).unwrap();
        book.invite(&p, &other, &guest.id).unwrap();
    }
    let invite = book.invite(&owner, &id, &guest.id).unwrap();
    let other_id = book.create(&outsider).unwrap();
    assert!(book.invite(&outsider, &other_id, &guest.id).is_err());
    assert!(book.invite(&owner, &id, &outsider.id).is_err());
    assert!(book.decline(&outsider, &invite).is_err());
    assert!(book.decline(&peer("guest", 2), &invite).is_err());
    book.decline(&guest, &invite).unwrap();
    assert!(book.join(&guest, &invite).is_err());
    assert!(book.decline(&guest, &invite).is_err());
    assert_eq!(
        book.invitations(&guest).unwrap().as_array().unwrap().len(),
        15
    );
    book.invite(&owner, &id, &outsider.id).unwrap();
    book.invite(&outsider, &other_id, &guest.id).unwrap();
}

#[test]
fn lost_membership_hint_can_be_reconciled_without_consuming_messages() {
    let mut book = Book::default();
    let owner = peer("owner", 1);
    let guest = peer("guest", 1);
    let id = book.create(&owner).unwrap();
    book.subscribe(&owner, Some(&id), MEMBERS_CHANGED.into(), true)
        .unwrap();
    book.subscribe(&owner, Some(&id), "activity".into(), true)
        .unwrap();
    book.signal(&guest).unwrap();
    let invite = book.invite(&owner, &id, &guest.id).unwrap();
    book.join(&guest, &invite).unwrap();
    // Simulate a chatty private channel pushing the membership notification out.
    for i in 0..QUEUE {
        book.publish(&guest, Some(&id), "activity".into(), json!(i))
            .unwrap();
    }
    let snapshot = book.snapshot(&owner).unwrap();
    assert_eq!(
        snapshot["channels"],
        json!([{"busId":id,"ownerPluginId":"owner","members":["guest","owner"],"topics":["activity",MEMBERS_CHANGED]}])
    );
    let batch = book.drain(&owner).unwrap();
    assert_eq!(batch["lost"], 1);
    assert_eq!(batch["messages"][0]["topic"], "activity");
    assert_eq!(book.snapshot(&owner).unwrap(), snapshot);
}
