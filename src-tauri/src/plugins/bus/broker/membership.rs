use super::*;

impl Book {
    pub(in crate::plugins::bus) fn snapshot(&mut self, peer: &Peer) -> AppResult<Value> {
        let inbox = self.inbox(peer)?;
        let mut topics = HashMap::<String, Vec<String>>::new();
        for (bus, topic) in &inbox.topics {
            topics.entry(bus.clone()).or_default().push(topic.clone());
        }
        for list in topics.values_mut() {
            list.sort_unstable();
        }
        let public_topics = topics.remove(PUBLIC).unwrap_or_default();
        let mut joined: Vec<_> = self
            .channels
            .iter()
            .filter(|(_, c)| c.members.contains(peer))
            .collect();
        joined.sort_unstable_by_key(|(id, _)| *id);
        let channels: Vec<_> = joined
            .into_iter()
            .map(|(id, channel)| {
                let mut members: Vec<_> = channel.members.iter().map(|p| &p.id).collect();
                members.sort_unstable();
                json!({
                    "busId": id, "ownerPluginId": channel.owner.id,
                    "members": members, "topics": topics.remove(id).unwrap_or_default(),
                })
            })
            .collect();
        Ok(json!({"publicTopics": public_topics, "channels": channels}))
    }

    // An opt-in private invalidation, not a delta. Use the regular delivery path
    // so bounds, wakeups and cleanup on leave/close also apply to these hints.
    pub(super) fn members_changed(&mut self, id: &str) {
        let members = self.channels[id].members.clone();
        self.broadcast(
            Message {
                sender: None,
                bus_id: id.into(),
                body: json!({"busId":id,"topic":MEMBERS_CHANGED,"sender":null,"payload":null}),
            },
            MEMBERS_CHANGED.into(),
            Some(&members),
        );
    }
}
